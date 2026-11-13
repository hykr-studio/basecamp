// /api/platform: the operators' routes (B19). People only, signed in, operators holding what each
// route needs (OperatorGuard). Every write goes through runWrite: an action in a business as the
// operator's system job there (audited there, on behalf of the operator), an operator change as
// the operator themselves, on behalf of the platform.
import {
  AddOperatorInput,
  type Operator,
  PlatformCapabilities,
  type PlatformMe,
  type Principal,
  ProvisionTenantInput,
  RenameTenantInput,
  SetPlatformFeatureInput,
  SupportRequestInput,
  storableDateTime,
  UpdateOperatorInput,
} from '@hykr/contracts';
import {
  type ApiRequest,
  allow,
  CORE_OPTIONS,
  type CoreOptions,
  RequestMeta,
  type RequestMetaValue,
  runWrite,
  TenantConfigService,
  type WriteOp,
} from '@hykr/core';
import { platformOperators, routedRequests, supportGrants, tenants, user } from '@hykr/db';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SetFeature } from '../settings/commands.js';
import {
  type ActingOperator,
  CurrentOperator,
  listOperators,
  OperatorCan,
  OperatorGuard,
  operatorOf,
  operatorPrincipal,
  unknownOperatorCapabilities,
} from './operators.js';
import { parsed } from './parse.js';
import { toRouted } from './routing.js';
import { activityOf, endSupport, grantsWhere, requestSupport } from './support.js';
import {
  isSameBusiness,
  listTenants,
  newTenantId,
  oneTenant,
  provisionTenant,
  renameTenant,
} from './tenants.js';
import { UsageQuery, usageReport } from './usage.js';

// biome-ignore lint/suspicious/noExplicitAny: any write op
type AnyOp = WriteOp<any, any, any>;

/** The operator, at no business: for writes about operators themselves. */
const asPlatform = (o: ActingOperator): Principal => ({
  actor: { kind: 'user', id: o.userId },
  subject: { kind: 'user', userId: o.userId },
  roles: [],
  capabilities: [],
  assurance: 'session',
  scopes: [],
  channel: 'api',
  onBehalfOf: { kind: 'operator', operatorId: o.id },
});

const TenantsQuery = z
  .object({
    q: z.string().max(120).optional(),
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const RoutingQuery = z
  .object({
    status: z.enum(['routed', 'unrouted', 'failed']).optional(),
    tenantId: z.uuid().optional(),
    // A time Postgres can store: `z.iso.datetime()` takes the year 0000 (V10).
    before: storableDateTime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const SupportQuery = z.object({ tenantId: z.uuid().optional() }).strict();

/** Whether the signed-in person is an operator: any signed-in person may ask. */
@Controller('api/platform/me')
@OptionalAuth()
export class PlatformMeController {
  constructor(@Inject(CORE_OPTIONS) private readonly core: CoreOptions) {}

  @Get()
  async me(@Req() req: ApiRequest): Promise<PlatformMe> {
    const userId = req.session?.user?.id;
    if (!userId) throw new UnauthorizedException();
    const operator = await operatorOf(this.core.db, userId);
    return { operator: operator ? { id: operator.id, capabilities: operator.capabilities } : null };
  }
}

@Controller('api/platform')
@OptionalAuth()
@UseGuards(OperatorGuard)
export class PlatformController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(TenantConfigService) private readonly tenantConfig: TenantConfigService,
  ) {}

  private async write(p: Principal, meta: RequestMetaValue, op: AnyOp, input: unknown) {
    const { result, events } = await runWrite(
      this.core.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input ?? {},
    );
    for (const event of events) this.events.publish(event);
    return result;
  }

  private async business(id: string) {
    const [row] = await this.core.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, id));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such business' });
    return row.id;
  }

  /* ── Operators ─────────────────────────────────────────────────────────── */

  @Get('operators')
  @OperatorCan(PlatformCapabilities.operators)
  operators(): Promise<Operator[]> {
    return listOperators(this.core.db);
  }

  /** Make a person (who has an account) an operator, with these capabilities. */
  @Post('operators')
  @OperatorCan(PlatformCapabilities.operators)
  async addOperator(
    @CurrentOperator() o: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    const input = parsed(AddOperatorInput, body);
    const unknown = unknownOperatorCapabilities(input.capabilities);
    if (unknown.length)
      throw new BadRequestException({
        error: 'unknown_capability',
        reason: `No operator capability ${unknown.join(', ')}`,
      });
    return this.write(asPlatform(o), meta, addOperatorOp(o.id), input);
  }

  /** Change an operator's capabilities or note, or disable (enable) them. Never one's own. */
  @Patch('operators/:id')
  @OperatorCan(PlatformCapabilities.operators)
  async updateOperator(
    @CurrentOperator() o: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parsed(UpdateOperatorInput, body);
    if (id === o.id)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'own_operator',
        reason: 'Another operator changes your access',
      });
    const unknown = unknownOperatorCapabilities(input.capabilities ?? []);
    if (unknown.length)
      throw new BadRequestException({
        error: 'unknown_capability',
        reason: `No operator capability ${unknown.join(', ')}`,
      });
    return this.write(asPlatform(o), meta, updateOperatorOp(id), input);
  }

  /* ── Businesses ────────────────────────────────────────────────────────── */

  @Get('tenants')
  @OperatorCan(PlatformCapabilities.tenants)
  tenants(@Query() query: unknown) {
    return listTenants(this.core.db, parsed(TenantsQuery, query));
  }

  @Get('tenants/:id')
  @OperatorCan(PlatformCapabilities.tenants)
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return oneTenant(this.core.db, id);
  }

  /**
   * Make a business for a person who has an account: they own it. A retry with the same
   * idempotency key answers the first answer, even when both arrive at once.
   */
  @Post('tenants')
  @OperatorCan(PlatformCapabilities.tenants)
  async provision(
    @CurrentOperator() o: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    const input = parsed(ProvisionTenantInput, body);
    const id = newTenantId(o.id, meta.idempotencyKey);
    const make = () =>
      this.write(
        operatorPrincipal(id, 'platform.tenants', o),
        meta,
        provisionTenant(id, o.id),
        input,
      );
    try {
      return await make();
    } catch (e) {
      // The same key at the same time: the other request made it, so its stored answer is ours.
      if (!meta.idempotencyKey || !isSameBusiness(e)) throw e;
      try {
        return await make();
      } catch (again) {
        if (!isSameBusiness(again)) throw again;
        throw new ConflictException({
          error: 'conflict',
          reason: 'This idempotency-key already made a business',
        });
      }
    }
  }

  @Patch('tenants/:id')
  @OperatorCan(PlatformCapabilities.tenants)
  async rename(
    @CurrentOperator() o: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parsed(RenameTenantInput, body);
    const tenantId = await this.business(id);
    try {
      return await this.write(
        operatorPrincipal(tenantId, 'platform.tenants', o),
        meta,
        renameTenant(tenantId),
        input,
      );
    } finally {
      this.tenantConfig.invalidate(tenantId);
    }
  }

  /** Switch a business's feature flag, the platform-managed ones included. */
  @Put('tenants/:id/features/:key')
  @OperatorCan(PlatformCapabilities.tenants)
  async feature(
    @CurrentOperator() o: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    const { on } = parsed(SetPlatformFeatureInput, body);
    const tenantId = await this.business(id);
    try {
      return await this.write(
        operatorPrincipal(tenantId, 'platform.flags', o),
        meta,
        SetFeature.op(),
        {
          key,
          on,
        },
      );
    } finally {
      this.tenantConfig.invalidate(tenantId);
    }
  }

  /* ── Support access ────────────────────────────────────────────────────── */

  /** The operator's own support grants, newest first (one business's, with `tenantId`). */
  @Get('support')
  @OperatorCan(PlatformCapabilities.support)
  support(@CurrentOperator() o: ActingOperator, @Query() query: unknown) {
    const { tenantId } = parsed(SupportQuery, query);
    return grantsWhere(
      this.core.db,
      and(
        eq(supportGrants.operatorId, o.id),
        tenantId ? eq(supportGrants.tenantId, tenantId) : undefined,
      ),
    );
  }

  /** Ask a business for access. It waits for the business's consent. */
  @Post('support')
  @OperatorCan(PlatformCapabilities.support)
  async askSupport(
    @CurrentOperator() o: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    const input = parsed(SupportRequestInput, body);
    const tenantId = await this.business(input.tenantId);
    return this.write(
      operatorPrincipal(tenantId, 'platform.support', o),
      meta,
      requestSupport(o),
      input,
    );
  }

  @Get('support/:id')
  @OperatorCan(PlatformCapabilities.support)
  async oneSupport(@CurrentOperator() o: ActingOperator, @Param('id', ParseUUIDPipe) id: string) {
    const [grant] = await grantsWhere(
      this.core.db,
      and(eq(supportGrants.id, id), eq(supportGrants.operatorId, o.id)),
      1,
    );
    if (!grant)
      throw new NotFoundException({ error: 'not_found', message: 'No such support access' });
    return grant;
  }

  @Get('support/:id/activity')
  @OperatorCan(PlatformCapabilities.support)
  async supportActivity(
    @CurrentOperator() o: ActingOperator,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.oneSupport(o, id);
    return activityOf(this.core.db, id);
  }

  /** End one's own support access now (asked or active). */
  @Delete('support/:id')
  @HttpCode(200)
  @OperatorCan(PlatformCapabilities.support)
  async endSupport(
    @CurrentOperator() o: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const grant = await this.oneSupport(o, id);
    return this.write(
      operatorPrincipal(grant.tenantId, 'platform.support', o),
      meta,
      endSupport(id, { operator: o }),
      {},
    );
  }

  /* ── Usage and routing ─────────────────────────────────────────────────── */

  @Get('usage')
  @OperatorCan(PlatformCapabilities.usage)
  usage(@Query() query: unknown) {
    return usageReport(this.core.db, parsed(UsageQuery, query));
  }

  @Get('routing')
  @OperatorCan(PlatformCapabilities.routing)
  async routing(@Query() query: unknown) {
    const q = parsed(RoutingQuery, query);
    const rows = await this.core.db
      .select()
      .from(routedRequests)
      .where(
        and(
          q.status ? eq(routedRequests.status, q.status) : undefined,
          q.tenantId ? eq(routedRequests.tenantId, q.tenantId) : undefined,
          q.before ? lt(routedRequests.createdAt, new Date(q.before)) : undefined,
        ),
      )
      .orderBy(desc(routedRequests.createdAt))
      .limit(q.limit);
    return rows.map(toRouted);
  }
}

/* ── Operator writes ───────────────────────────────────────────────────────── */

type OperatorRow = typeof platformOperators.$inferSelect;

const operatorJson = (r: OperatorRow) => ({
  id: r.id,
  userId: r.userId,
  capabilities: r.capabilities,
  note: r.note,
  disabledAt: r.disabledAt?.toISOString() ?? null,
});

/** Make the person with this email an operator (an account is needed; one operator each). */
export const addOperatorOp = (
  by: string,
): WriteOp<AddOperatorInput, { userId: string }, Operator | undefined> => ({
  name: 'platform.operators.add',
  kind: 'command',
  resourceType: 'operator',
  input: AddOperatorInput,
  resourceId: () => null,
  system: true,
  async load(tx, _p, input) {
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${input.email.toLowerCase()}`)
      .limit(2);
    if (found.length !== 1)
      throw new NotFoundException({
        error: 'no_account',
        reason: 'Nobody has an account with this email: ask them to sign up first',
      });
    const [already] = await tx
      .select({ id: platformOperators.id })
      .from(platformOperators)
      .where(eq(platformOperators.userId, found[0].id));
    if (already)
      throw new ConflictException({
        error: 'already_operator',
        reason: 'This person is an operator already',
        id: already.id,
      });
    return { userId: found[0].id };
  },
  authorize: () => allow('operators_manage', 'An operator adds an operator'),
  summarize: (input) => `Make ${input.email} an operator`,
  async run({ tx, input, loaded }) {
    const [row] = await tx
      .insert(platformOperators)
      .values({
        userId: loaded.userId,
        capabilities: [...new Set(input.capabilities)].sort(),
        note: input.note ?? null,
        addedBy: by,
      })
      .returning();
    const [view] = await listOperators(tx, row.id);
    return {
      value: view,
      touched: [{ type: 'operator', id: row.id, change: 'created', after: operatorJson(row) }],
    };
  },
  present: (value) => value,
});

/** Change an operator's capabilities or note, or disable or enable them. */
export const updateOperatorOp = (
  id: string,
): WriteOp<UpdateOperatorInput, OperatorRow, Operator | undefined> => ({
  name: 'platform.operators.update',
  kind: 'command',
  resourceType: 'operator',
  input: UpdateOperatorInput,
  args: { id },
  resourceId: () => id,
  system: true,
  async load(tx) {
    const [row] = await tx
      .select()
      .from(platformOperators)
      .where(eq(platformOperators.id, id))
      .for('update');
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such operator' });
    return row;
  },
  authorize: () => allow('operators_manage', 'An operator changes an operator'),
  summarize: (_i, row) => `Change operator ${row.id}`,
  async run({ tx, input, loaded }) {
    const [row] = await tx
      .update(platformOperators)
      .set({
        ...(input.capabilities ? { capabilities: [...new Set(input.capabilities)].sort() } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.enabled === false && !loaded.disabledAt ? { disabledAt: new Date() } : {}),
        ...(input.enabled === true ? { disabledAt: null } : {}),
      })
      .where(eq(platformOperators.id, id))
      .returning();
    const [view] = await listOperators(tx, id);
    return {
      value: view,
      touched: [
        {
          type: 'operator',
          id,
          change: 'updated',
          before: operatorJson(loaded),
          after: operatorJson(row),
        },
      ],
    };
  },
  present: (value) => value,
});
