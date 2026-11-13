// A routing hook for inbound requests (B19). The platform receives a request no business owns yet
// (a message to the platform's own number, a form, a connector's webhook): the application's
// routers say which business takes it, and the chosen router's `deliver` makes what that business
// needs of it, as the system principal there, once per request. The framework holds no routing
// rule: which business, and what it makes, are the application's.
import { randomUUID } from 'node:crypto';
import {
  createHookRegistry,
  type Principal,
  type RoutedRequest,
  type WriteResult,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  platformTenantId,
  runWrite,
  systemPrincipal,
  type Tx,
  tenantZoneOf,
  type WriteOp,
} from '@hykr/core';
import {
  type AuditInput,
  contacts,
  customers,
  type Database,
  routedRequests,
  tenants,
  writeAuditMany,
} from '@hykr/db';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type InboundHook, type InboundInfo, inboundHooks } from '../../hooks.js';

declare module '@hykr/contracts' {
  interface Contributions {
    inboundRouters: readonly InboundRouter[];
  }
}

/** One inbound request, as its source gives it. */
export interface InboundRequest {
  /** Where it came from: 'whatsapp' (a message to the platform's number), or a caller's name. */
  source: string;
  /** Its id at the source: a request is routed once per (source, ref). */
  ref: string;
  /** Who sent it, as the source knows them. `address`: a WhatsApp number (digits). */
  from?: { address?: string; name?: string; email?: string };
  /** What it says. */
  text?: string;
  /** Anything else the source gives (a form's fields). */
  data?: Record<string, unknown>;
}

const Request = z.object({
  source: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/),
  ref: z.string().min(1).max(200),
  from: z
    .object({
      address: z
        .string()
        .regex(/^\d{6,15}$/)
        .optional(),
      name: z.string().max(200).optional(),
      email: z.string().max(320).optional(),
    })
    .optional(),
  text: z.string().max(20_000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** What a router may use to decide: the database (to read), and any provider. */
export interface RouteContext {
  db: Database;
  get<T>(token: string | symbol | (new (...args: never[]) => T)): T;
}

/** The business a router chose, as its `deliver` works in it. */
export interface RouteTarget {
  tenantId: string;
  /** The system principal there (`platform.route`): every write it makes is audited as it. */
  principal: Principal;
  /**
   * One write through the write path, in this delivery's transaction, as the system principal
   * (for this business's customer when `customerId` is given). A write that would wait for
   * approval fails the delivery (nobody would decide it).
   */
  write<V = unknown>(
    // biome-ignore lint/suspicious/noExplicitAny: any entity or command op
    op: WriteOp<any, any, any>,
    input: unknown,
    opts?: { customerId?: string },
  ): Promise<V>;
  /**
   * The sender as this business's WhatsApp contact (found, or made, with a customer record unless
   * `customer: false`), from `from.address`. Null when the request has no number.
   */
  contact(opts?: {
    customer?: boolean;
  }): Promise<{ contactId: string; customerId: string | null } | null>;
  ctx: RouteContext;
}

export interface InboundRouter {
  /** Unique: 'by-area'. */
  name: string;
  /** Which business takes it, or null (the next router decides). The application's rules. */
  route(
    req: InboundRequest,
    ctx: RouteContext,
  ): Promise<{ tenantId: string; reason?: string } | null>;
  /** What the chosen business makes of it. What it returns is kept in the routing log. */
  deliver(
    req: InboundRequest,
    target: RouteTarget,
  ): Promise<{ resourceType?: string; resourceId?: string } | undefined>;
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** A router, checked: its name. */
export function defineInboundRouter(def: InboundRouter): InboundRouter {
  if (!NAME.test(def.name))
    throw new Error(`Inbound router "${def.name}": lower case letters, digits and "-"`);
  return def;
}

/** The application's routers, asked in order. Collects `contributes.inboundRouters`. */
export const inboundRouters = createHookRegistry<InboundRouter>(
  'inbound router',
  (r) => defineInboundRouter(r).name,
  { collects: 'inboundRouters' },
);

type RoutedRow = typeof routedRequests.$inferSelect;

export const toRouted = (r: RoutedRow): RoutedRequest => ({
  id: r.id,
  source: r.source,
  ref: r.ref,
  router: r.router,
  tenantId: r.tenantId,
  status: r.status,
  reason: r.reason,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  error: r.error,
  attempts: r.attempts,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const log = new Logger('PlatformRouting');

/** The job the deliveries run as, as audited. */
export const ROUTE_JOB = 'platform.route';

/** A delivery's write parked: nobody would decide it, so the delivery fails. */
class Parked extends Error {}

/**
 * Routes inbound requests: asks the routers in order, checks the business one chose exists (and
 * is not the platform's own), then runs that router's `deliver` in one transaction as the system
 * principal there. A request already routed answers what it was; one that failed may be tried
 * again. Server code calls `route` (a connector's inbound handler, a form's controller); the
 * platform's WhatsApp number comes through the inbound hook below.
 */
@Injectable()
export class PlatformRoutingService {
  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {
    this.db = core.db;
  }

  private context(): RouteContext {
    return {
      db: this.db,
      get: (token) => this.moduleRef.get(token as never, { strict: false }),
    };
  }

  /** Record what happened to it (one row per source and ref). */
  private async save(
    req: InboundRequest,
    values: Partial<typeof routedRequests.$inferInsert> & { status: RoutedRow['status'] },
    tx: Tx | Database = this.db,
  ): Promise<RoutedRow> {
    const row = {
      router: null,
      tenantId: null,
      reason: null,
      resourceType: null,
      resourceId: null,
      error: null,
      ...values,
    };
    const [saved] = await tx
      .insert(routedRequests)
      .values({ source: req.source, ref: req.ref, ...row })
      .onConflictDoUpdate({
        target: [routedRequests.source, routedRequests.ref],
        set: { ...row, attempts: sql`${routedRequests.attempts} + 1`, updatedAt: new Date() },
      })
      .returning();
    return saved;
  }

  async route(raw: InboundRequest): Promise<RoutedRequest> {
    const parsed = Request.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException({ error: 'invalid_request', issues: parsed.error.issues });
    const req = parsed.data as InboundRequest;
    const [before] = await this.db
      .select()
      .from(routedRequests)
      .where(and(eq(routedRequests.source, req.source), eq(routedRequests.ref, req.ref)));
    if (before?.status === 'routed') return toRouted(before);

    const ctx = this.context();
    let chosen: { router: InboundRouter; tenantId: string; reason?: string } | undefined;
    for (const router of inboundRouters.all()) {
      const picked = await router.route(req, ctx);
      if (!picked) continue;
      chosen = { router, ...picked };
      break;
    }
    if (!chosen) return toRouted(await this.save(req, { status: 'unrouted' }));
    const { router, tenantId } = chosen;
    const reason = chosen.reason?.slice(0, 500) ?? null;
    const [business] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const refused = !business
      ? 'The router chose no business that exists'
      : tenantId === platformTenantId()
        ? "The router chose the platform's own business"
        : undefined;
    if (refused)
      return toRouted(
        await this.save(req, { status: 'failed', router: router.name, reason, error: refused }),
      );

    const published: object[] = [];
    // A refused write's audit row: with the delivery when the router got past it, else once the
    // refusal has rolled the transaction back. Never on a second connection while it holds one.
    const refusals: AuditInput[] = [];
    try {
      const saved = await this.db.transaction(async (tx) => {
        // One delivery of a request at a time: a second caller waits, then finds it routed.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`platform.route:${req.source}:${req.ref}`}, 0))`,
        );
        const [again] = await tx
          .select()
          .from(routedRequests)
          .where(and(eq(routedRequests.source, req.source), eq(routedRequests.ref, req.ref)));
        if (again?.status === 'routed') return again;
        const requestId = randomUUID();
        const runId = randomUUID();
        const principal = (customerId?: string) =>
          systemPrincipal({ tenantId, job: ROUTE_JOB, runId, customerId });
        const target: RouteTarget = {
          tenantId,
          principal: principal(),
          ctx,
          write: async <V>(
            // biome-ignore lint/suspicious/noExplicitAny: any entity or command op
            op: WriteOp<any, any, any>,
            input: unknown,
            opts?: { customerId?: string },
          ) => {
            if (opts?.customerId) await this.customerOf(tx as Tx, tenantId, opts.customerId);
            const { result, events } = await runWrite(
              this.db,
              {
                principal: principal(opts?.customerId),
                requestId,
                outer: { tx: tx as Tx, refused: (audit) => refusals.push(audit) },
              },
              op,
              input,
            );
            if (result.status !== 'done')
              throw new Parked('A delivery write cannot wait for approval');
            published.push(...events);
            return (result as Extract<WriteResult, { status: 'done' }>).value as V;
          },
          contact: async (opts) => {
            const address = req.from?.address;
            if (!address) return null;
            const contact = await contactIn(tx as Tx, tenantId, address, req.from?.name, {
              customer: opts?.customer ?? true,
            });
            return { contactId: contact.id, customerId: contact.customerId ?? null };
          },
        };
        const made = (await router.deliver(req, target)) ?? {};
        if (refusals.length) await writeAuditMany(tx as Tx, refusals);
        return this.save(
          req,
          {
            status: 'routed',
            router: router.name,
            tenantId,
            reason,
            resourceType: made.resourceType ?? null,
            resourceId: made.resourceId ?? null,
          },
          tx as Tx,
        );
      });
      for (const event of published) this.events.publish(event);
      return toRouted(saved);
    } catch (e) {
      if (refusals.length) await writeAuditMany(this.db, refusals);
      const error = e instanceof Error ? e.message : String(e);
      log.warn(
        `routing ${req.source}:${req.ref} to ${tenantId} by ${router.name} failed: ${error}`,
      );
      return toRouted(
        await this.save(req, {
          status: 'failed',
          router: router.name,
          tenantId,
          reason,
          error: error.slice(0, 1000),
        }),
      );
    }
  }

  /** A customer of this business, or 400: a delivery writes for its own business's customers. */
  private async customerOf(tx: Tx, tenantId: string, customerId: string) {
    const [row] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)));
    if (!row)
      throw new ConflictException({
        error: 'not_this_business',
        reason: 'That customer is not this business’s',
      });
  }
}

/**
 * The sender as this business's WhatsApp contact, found or made in the delivery's transaction,
 * with a customer record when asked (as the business's inbound pipeline makes one). They did not
 * write to this business, so no consent is recorded for them here.
 */
async function contactIn(
  tx: Tx,
  tenantId: string,
  address: string,
  name: string | undefined,
  opts: { customer: boolean },
) {
  const mine = and(
    eq(contacts.tenantId, tenantId),
    eq(contacts.channel, 'whatsapp'),
    eq(contacts.address, address),
  );
  const [found] = await tx.select().from(contacts).where(mine);
  if (found) return found;
  const [created] = await tx
    .insert(contacts)
    .values({
      tenantId,
      channel: 'whatsapp',
      address,
      profileName: name,
      timeZone: await tenantZoneOf(tx, tenantId),
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [existing] = await tx.select().from(contacts).where(mine);
    return existing;
  }
  if (!opts.customer) return created;
  const [customer] = await tx
    .insert(customers)
    .values({ tenantId, displayName: name || `+${address}`, contactId: created.id })
    .returning();
  const [linked] = await tx
    .update(contacts)
    .set({ customerId: customer.id })
    .where(eq(contacts.id, created.id))
    .returning();
  return linked;
}

/** What a message says, as text: its words, or the title of what was tapped. */
function wordsOf(m: InboundInfo['message']): string | undefined {
  switch (m.body.kind) {
    case 'text':
      return m.body.text;
    case 'list':
      return m.body.title;
    case 'button':
      return m.body.text;
    case 'media':
      return m.body.caption;
    default:
      return undefined;
  }
}

/**
 * Messages that reach the platform's own business (PLATFORM_TENANT_ID: a number it claimed) are
 * routed: one a router delivers is handled (the platform's assistant stays silent); one nobody
 * routes, or that fails, reaches the platform's assistant as any message does.
 */
@Injectable()
export class PlatformInboundHook implements InboundHook, OnModuleInit {
  readonly name = 'platform-routing';

  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    @Inject(PlatformRoutingService) private readonly routing: PlatformRoutingService,
  ) {}

  onModuleInit() {
    if (!inboundHooks.has(this.name)) inboundHooks.register(this);
  }

  async onMessage(info: InboundInfo) {
    const platform = platformTenantId();
    if (!platform || info.tenantId !== platform || !inboundRouters.all().length) return null;
    const [contact] = await this.core.db
      .select({ address: contacts.address, name: contacts.profileName })
      .from(contacts)
      .where(eq(contacts.id, info.contactId));
    const routed = await this.routing.route({
      source: 'whatsapp',
      ref: info.message.providerMessageId,
      from: {
        address: contact?.address ?? info.message.from,
        ...((contact?.name ?? info.message.profileName)
          ? { name: contact?.name ?? info.message.profileName }
          : {}),
      },
      ...(wordsOf(info.message) ? { text: wordsOf(info.message) } : {}),
      data: { kind: info.message.body.kind },
    });
    return routed.status === 'routed' ? ({ handled: true } as const) : null;
  }
}
