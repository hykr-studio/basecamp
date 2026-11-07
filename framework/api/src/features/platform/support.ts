// Support access (B19): an operator asks one business for access, for a reason, with roles (which
// rows) and capabilities (which features), read-only unless asked otherwise; a person of the
// business holding `support.consent` consents or declines; it lasts the minutes consented and
// ends at once when revoked. While it lasts, the operator stands in the business as `support`
// (the standing provider below), every request is logged, and every write audited
// `on_behalf_of = support:<grant>`. Every step is a write through runWrite.
import {
  type AuthorizeResult,
  capabilities,
  createHookRegistry,
  isGrantable,
  type OnBehalfOf,
  PlatformCapabilities,
  type Principal,
  RolesSettings,
  type SupportActivity,
  SupportConsentCapability,
  SupportConsentInput,
  type SupportGrant,
  type SupportGrantStatus,
  SupportRequestInput,
  SupportSettings,
  SupportSettingsInput,
  standingIn,
} from '@hykr/contracts';
import {
  type ApiRequest,
  allow,
  CORE_OPTIONS,
  type CoreOptions,
  deny,
  type StandingProvider,
  type Tx,
  type WriteHook,
  type WriteOp,
} from '@hykr/core';
import {
  type Database,
  type DbOrTx,
  platformOperators,
  supportGrants,
  supportLog,
  tenants,
  user,
} from '@hykr/db';
import { can } from '@hykr/policy';
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { type Observable, tap } from 'rxjs';
import { z } from 'zod';
import type { ActingOperator } from './operators.js';

type Values = Record<string, unknown>;
type GrantRow = typeof supportGrants.$inferSelect;

declare module '@hykr/contracts' {
  interface Contributions {
    supportWithheld: readonly string[];
  }
}

/**
 * Capabilities support access never holds, whatever the business consents to: those that change
 * who reaches the business (or what leaves it) beyond the time box. The framework's own; an
 * application adds its own as `supportWithheld`.
 */
export const FRAMEWORK_WITHHELD: readonly string[] = [
  'members.manage',
  'records.grant',
  'parties.manage',
  'support.consent',
  'channels.manage',
  'settings.manage',
  'models.manage',
  'credits.manage',
  'integrations.manage',
  'data.export',
];

/** Every withheld capability. Collects `contributes.supportWithheld`. */
export const supportWithheld = createHookRegistry<string>('withheld capability', (n) => n, {
  collects: 'supportWithheld',
});

/** May support access hold this capability? Defined, grantable by a business, not withheld. */
export const supportMayHold = (name: string) =>
  capabilities.has(name) && isGrantable(name) && !supportWithheld.has(name);

/** A support event, stored in the outbox with the write (subscribers may tell someone). */
export class SupportEvent {
  readonly resourceType = 'support_grant';
  constructor(
    readonly eventName:
      | 'support.requested'
      | 'support.consented'
      | 'support.declined'
      | 'support.ended',
    readonly row: SupportGrant,
  ) {}
}

/** Where a grant stands at this moment. */
export function statusOf(g: GrantRow, now = new Date()): SupportGrantStatus {
  if (g.declinedAt) return 'declined';
  if (g.endedHow === 'revoked') return 'revoked';
  if (g.endedHow === 'ended') return 'ended';
  if (g.consentedAt) return g.endsAt && g.endsAt > now ? 'active' : 'ended';
  return g.requestExpiresAt > now ? 'requested' : 'expired';
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** A grant as the business and its operator see it. */
export function toGrant(g: GrantRow, operator: SupportGrant['operator']): SupportGrant {
  return {
    id: g.id,
    tenantId: g.tenantId,
    operator,
    reason: g.reason,
    roles: g.roles,
    capabilities: g.capabilities,
    access: g.access,
    minutes: g.minutes,
    status: statusOf(g),
    requestedAt: g.requestedAt.toISOString(),
    requestExpiresAt: g.requestExpiresAt.toISOString(),
    consentedBy: g.consentedBy,
    consentedAt: iso(g.consentedAt),
    endsAt: iso(g.endsAt),
    decidedAt: iso(g.consentedAt ?? g.declinedAt),
    endedAt: iso(g.endedAt),
    endedBy: g.endedBy,
  };
}

/** Grants with their operator's name and email, newest first. */
export async function grantsWhere(db: DbOrTx, where: ReturnType<typeof and>, limit = 100) {
  const rows = await db
    .select({ g: supportGrants, name: user.name, email: user.email })
    .from(supportGrants)
    .innerJoin(platformOperators, eq(platformOperators.id, supportGrants.operatorId))
    .innerJoin(user, eq(user.id, platformOperators.userId))
    .where(where)
    .orderBy(desc(supportGrants.requestedAt))
    .limit(limit);
  return rows.map(({ g, name, email }) => toGrant(g, { id: g.operatorId, name, email }));
}

/** The requests made under one grant, newest first. */
export async function activityOf(db: DbOrTx, grantId: string): Promise<SupportActivity[]> {
  const rows = await db
    .select()
    .from(supportLog)
    .where(eq(supportLog.grantId, grantId))
    .orderBy(desc(supportLog.at))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    method: r.method,
    path: r.path,
    status: r.status,
    actorKind: r.actorKind,
    at: r.at.toISOString(),
  }));
}

const notFound = () =>
  new NotFoundException({ error: 'not_found', message: 'No such support access' });

/** The business's support and roles settings, as stored. */
async function settingsOf(tx: Tx, tenantId: string, lock = false) {
  const q = tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const [row] = await (lock ? q.for('update') : q);
  if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such business' });
  const raw = (row.settings && typeof row.settings === 'object' ? row.settings : {}) as Values;
  const parsed = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const r = schema.safeParse(value);
    if (!r.success)
      throw new ConflictException({
        error: 'settings_invalid',
        reason: `The business's ${what} settings do not parse`,
      });
    return r.data;
  };
  return {
    support: parsed(SupportSettings, raw.support, 'support'),
    roles: parsed(RolesSettings, raw.roles, 'roles'),
    before: raw.support ?? null,
  };
}

/** The operator side's view of a grant row, by id: theirs only. */
async function grantFor(tx: Tx, where: ReturnType<typeof and>): Promise<GrantRow> {
  const [row] = await tx.select().from(supportGrants).where(where).for('update');
  if (!row) throw notFound();
  return row;
}

type OperatorInfo = SupportGrant['operator'];

async function operatorInfo(tx: DbOrTx, operatorId: string): Promise<OperatorInfo> {
  const [row] = await tx
    .select({ name: user.name, email: user.email })
    .from(platformOperators)
    .innerJoin(user, eq(user.id, platformOperators.userId))
    .where(eq(platformOperators.id, operatorId));
  return { id: operatorId, name: row?.name ?? '', email: row?.email ?? '' };
}

/** A support write: the WriteOp runWrite takes. */
function op<I, L, V>(o: Omit<WriteOp<I, L, V>, 'kind' | 'present'>): WriteOp<I, L, V> {
  return { kind: 'command', present: (value) => value, ...o };
}

const touched = (id: string, change: 'created' | 'updated', before?: unknown, after?: unknown) => ({
  type: 'support_grant',
  id,
  change,
  before,
  after,
});

/**
 * An operator asks a business for access (run as the operator's system job there). Roles the
 * business does not have, and capabilities support may not hold, are 400; a business that takes
 * no requests, or asked for longer than it allows, refuses (403, audited).
 */
export const requestSupport = (operator: ActingOperator) =>
  op<SupportRequestInput, Awaited<ReturnType<typeof settingsOf>>, SupportGrant>({
    name: 'support.request',
    resourceType: 'support_grant',
    input: SupportRequestInput as unknown as z.ZodType<SupportRequestInput>,
    resourceId: () => null,
    system: true,
    async load(tx, _p, input) {
      const s = await settingsOf(tx, input.tenantId);
      const { unknown } = standingIn(input.roles, { roles: s.roles });
      if (unknown.length)
        throw new BadRequestException({
          error: 'unknown_role',
          reason: `The business has no role ${unknown.join(', ')}`,
        });
      const withheld = input.capabilities.filter((c) => !supportMayHold(c));
      if (withheld.length)
        throw new BadRequestException({
          error: 'capability_withheld',
          reason: `Support access cannot hold ${withheld.join(', ')}`,
        });
      return s;
    },
    authorize(_p, s, input): AuthorizeResult {
      if (!s.support.requests)
        return deny('support_closed', 'This business takes no support requests');
      if (input.minutes > s.support.maxMinutes)
        return deny(
          'support_too_long',
          `This business allows support access for ${s.support.maxMinutes} minutes at most`,
        );
      return allow('operator_asks', 'An operator asks for support access');
    },
    summarize: (input) => `Support access for ${input.minutes} minutes: ${input.reason}`,
    async run({ tx, input, loaded: s }) {
      const [row] = await tx
        .insert(supportGrants)
        .values({
          tenantId: input.tenantId,
          operatorId: operator.id,
          userId: operator.userId,
          reason: input.reason,
          access: input.access,
          roles: [...new Set(input.roles)],
          capabilities: [...new Set(input.capabilities)].sort(),
          minutes: input.minutes,
          requestExpiresAt: new Date(Date.now() + s.support.requestHours * 3_600_000),
        })
        .returning();
      const grant = toGrant(row, await operatorInfo(tx, operator.id));
      return {
        value: grant,
        touched: [touched(row.id, 'created', undefined, grant)],
        events: [new SupportEvent('support.requested', grant)],
      };
    },
  });

/** Refused unless p consents for the business (its own people: support never holds it). */
const consents = (p: Principal): AuthorizeResult | null =>
  can(p, SupportConsentCapability)
    ? null
    : deny('support_consent', 'Only people who decide on support access can do this');

/** A grant of this business, locked: 404 for anything else. */
const businessGrant = (tx: Tx, p: Principal, id: string) =>
  grantFor(tx, and(eq(supportGrants.id, id), eq(supportGrants.tenantId, p.tenantId ?? '')));

/** The business consents: as asked, shorter, or read-only; never longer, never more. */
export const consentSupport = (id: string) =>
  op<SupportConsentInput, { g: GrantRow; maxMinutes: number }, SupportGrant>({
    name: 'support.consent',
    resourceType: 'support_grant',
    input: SupportConsentInput,
    args: { id },
    resourceId: () => id,
    async load(tx, p, input) {
      const g = await businessGrant(tx, p, id);
      if (statusOf(g) !== 'requested')
        throw new ConflictException({
          error: 'not_requested',
          reason: `This support access is ${statusOf(g)}`,
        });
      if (input.minutes !== undefined && input.minutes > g.minutes)
        throw new BadRequestException({
          error: 'longer_than_asked',
          reason: `The operator asked for ${g.minutes} minutes`,
        });
      if (input.access === 'write' && g.access === 'read')
        throw new BadRequestException({
          error: 'more_than_asked',
          reason: 'The operator asked to read only',
        });
      const s = await settingsOf(tx, g.tenantId);
      return { g, maxMinutes: s.support.maxMinutes };
    },
    authorize(p, { g, maxMinutes }, input) {
      const refused = consents(p);
      if (refused) return refused;
      if ((input.minutes ?? g.minutes) > maxMinutes)
        return deny(
          'support_too_long',
          `This business allows support access for ${maxMinutes} minutes at most`,
        );
      return allow('support_consented', 'The business lets support in');
    },
    summarize: (_i, { g }) => `Let support in: ${g.reason}`,
    async run({ tx, principal, input, loaded: { g } }) {
      const minutes = input.minutes ?? g.minutes;
      const now = new Date();
      const [row] = await tx
        .update(supportGrants)
        .set({
          minutes,
          access: input.access ?? g.access,
          consentedBy: principal.actor.id,
          consentedAt: now,
          endsAt: new Date(now.getTime() + minutes * 60_000),
        })
        .where(eq(supportGrants.id, g.id))
        .returning();
      const info = await operatorInfo(tx, g.operatorId);
      const grant = toGrant(row, info);
      return {
        value: grant,
        touched: [touched(g.id, 'updated', toGrant(g, info), grant)],
        events: [new SupportEvent('support.consented', grant)],
      };
    },
  });

/** The business says no to a request. */
export const declineSupport = (id: string) =>
  op<Record<string, never>, GrantRow, SupportGrant>({
    name: 'support.decline',
    resourceType: 'support_grant',
    input: z.object({}).strict(),
    args: { id },
    resourceId: () => id,
    async load(tx, p) {
      const g = await businessGrant(tx, p, id);
      if (statusOf(g) !== 'requested')
        throw new ConflictException({
          error: 'not_requested',
          reason: `This support access is ${statusOf(g)}`,
        });
      return g;
    },
    authorize: (p) => consents(p) ?? allow('support_declined', 'The business keeps support out'),
    summarize: (_i, g) => `Keep support out: ${g.reason}`,
    async run({ tx, principal, loaded: g }) {
      const [row] = await tx
        .update(supportGrants)
        .set({ declinedBy: principal.actor.id, declinedAt: new Date() })
        .where(eq(supportGrants.id, g.id))
        .returning();
      const info = await operatorInfo(tx, g.operatorId);
      const grant = toGrant(row, info);
      return {
        value: grant,
        touched: [touched(g.id, 'updated', toGrant(g, info), grant)],
        events: [new SupportEvent('support.declined', grant)],
      };
    },
  });

/**
 * End a grant that is asked or active, at once: the business revokes it (`revoked`), or the
 * operator ends it (`ended`, run as the operator's job in the business).
 */
export const endSupport = (id: string, by: { operator: ActingOperator } | 'business') =>
  op<Record<string, never>, GrantRow, SupportGrant>({
    name: by === 'business' ? 'support.revoke' : 'support.end',
    resourceType: 'support_grant',
    input: z.object({}).strict(),
    args: { id },
    resourceId: () => id,
    system: by !== 'business',
    async load(tx, p) {
      const g =
        by === 'business'
          ? await businessGrant(tx, p, id)
          : await grantFor(
              tx,
              and(eq(supportGrants.id, id), eq(supportGrants.operatorId, by.operator.id)),
            );
      const status = statusOf(g);
      if (status !== 'requested' && status !== 'active')
        throw new ConflictException({
          error: 'not_open',
          reason: `This support access is ${status}`,
        });
      return g;
    },
    authorize: (p) =>
      by === 'business'
        ? (consents(p) ?? allow('support_revoked', 'The business ends support access'))
        : allow('operator_ends', 'The operator ends their support access'),
    summarize: (_i, g) => `End support access: ${g.reason}`,
    async run({ tx, principal, loaded: g }) {
      const endedBy = by === 'business' ? principal.actor.id : `operator:${by.operator.id}`;
      const [row] = await tx
        .update(supportGrants)
        .set({
          endedBy,
          endedAt: new Date(),
          endedHow: by === 'business' ? 'revoked' : 'ended',
        })
        .where(eq(supportGrants.id, g.id))
        .returning();
      const info = await operatorInfo(tx, g.operatorId);
      const grant = toGrant(row, info);
      return {
        value: grant,
        touched: [touched(g.id, 'updated', toGrant(g, info), grant)],
        events: [new SupportEvent('support.ended', grant)],
      };
    },
  });

/** The business's `support` section, replaced (only that key of its settings). */
export const setSupportSettings = () =>
  op<SupportSettingsInput, { tenantId: string; before: unknown }, SupportSettings>({
    name: 'support.settings',
    resourceType: 'tenant',
    input: SupportSettingsInput,
    resourceId: (_i, l) => l.tenantId,
    async load(tx, p) {
      const tenantId = p.tenantId;
      if (!tenantId) throw new NotFoundException({ error: 'not_found' });
      const [row] = await tx
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      const raw = (row?.settings ?? {}) as Values;
      return { tenantId, before: raw.support ?? null };
    },
    authorize: (p) => consents(p) ?? allow('support_settings', 'Sets how support may ask'),
    summarize: () => 'Change how support may ask for access',
    async run({ tx, input, loaded }) {
      await tx
        .update(tenants)
        .set({
          settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{support}', ${JSON.stringify(input)}::jsonb)`,
        })
        .where(eq(tenants.id, loaded.tenantId));
      return {
        value: input,
        touched: [
          {
            type: 'tenant',
            id: loaded.tenantId,
            change: 'updated' as const,
            before: { support: loaded.before },
            after: { support: input },
          },
        ],
      };
    },
  });

/** Channels sure enough of the person for support access: never a number alone, nor a link. */
const SESSION_CHANNELS = new Set([undefined, 'app', 'api', 'voice', 'mcp', 'webmcp']);

/**
 * The operator's standing in a business while a consented grant lasts: the roles it names whose
 * access applies, only the capabilities it names that support may hold, on a signed-in channel,
 * while the operator is enabled and holds `platform.support`. The latest active grant wins.
 */
export const supportStanding: StandingProvider = {
  name: 'support',
  async forUser({ db, userId, tenantId, channel }) {
    if (!SESSION_CHANNELS.has(channel)) return null;
    const now = new Date();
    const [row] = await db
      .select({ g: supportGrants, capabilities: platformOperators.capabilities })
      .from(supportGrants)
      .innerJoin(platformOperators, eq(platformOperators.id, supportGrants.operatorId))
      .where(
        and(
          eq(supportGrants.userId, userId),
          eq(supportGrants.tenantId, tenantId),
          isNull(supportGrants.declinedAt),
          isNull(supportGrants.endedAt),
          gt(supportGrants.endsAt, now),
          isNull(platformOperators.disabledAt),
        ),
      )
      .orderBy(desc(supportGrants.consentedAt))
      .limit(1);
    if (!row?.g.endsAt || !row.capabilities.includes(PlatformCapabilities.support.name))
      return null;
    const g = row.g;
    const onBehalfOf: OnBehalfOf = {
      kind: 'support',
      operatorId: g.operatorId,
      grantId: g.id,
      access: g.access,
      until: (g.endsAt as Date).toISOString(),
    };
    return {
      roles: g.roles,
      capabilities: g.capabilities.filter(supportMayHold),
      standing: 'support',
      onBehalfOf,
    };
  },
};

/**
 * Read-only support access writes nothing, on any path (the guard already refuses its HTTP
 * writes; this is for everything else, an approval replay included).
 */
export const supportReadOnlyHook: WriteHook = {
  name: 'support-read-only',
  decide: ({ ctx }) => {
    const behalf = ctx.principal.onBehalfOf;
    return behalf?.kind === 'support' && behalf.access === 'read'
      ? deny('support_read_only', 'This support access can only read')
      : null;
  },
};

const log = new Logger('SupportAccess');

/**
 * Every request made under support access, reads included, kept for the business: the grant,
 * the method, the path (no query string) and the answer's status. A failure to log is logged,
 * never shown.
 */
@Injectable()
export class SupportLogInterceptor implements NestInterceptor {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const behalf = req.principal?.onBehalfOf;
    if (behalf?.kind !== 'support') return next.handle();
    // Once per request, even for a stream that emits many times.
    let logged = false;
    const record = (status: number) => {
      if (logged) return;
      logged = true;
      this.write(this.options.db, {
        grantId: behalf.grantId,
        tenantId: req.principal?.tenantId ?? '',
        actorKind: req.principal?.actor.kind ?? 'user',
        method: req.method,
        path: req.path.slice(0, 500),
        status,
      });
    };
    return next.handle().pipe(
      tap({
        next: () => record(http.getResponse<Response>().statusCode),
        error: (e: unknown) => record(e instanceof HttpException ? e.getStatus() : 500),
      }),
    );
  }

  private write(db: Database, row: typeof supportLog.$inferInsert) {
    db.insert(supportLog)
      .values(row)
      .catch((e: unknown) => log.error(`could not log a support request: ${e}`));
  }
}
