import { randomUUID } from 'node:crypto';
import { priceOf as modelPrice, type TokenUsage } from '@hykr/agents';
import {
  type CreditPurchase,
  CreditsManageCapability,
  type CreditsStatus,
  type CreditsThresholdRow,
  capabilitiesOf,
  type LedgerEntry,
  type MeterStatus,
  type UsageRefusal,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type Conn,
  type CoreOptions,
  type NamedEvent,
  recordEvents,
  registerOp,
  runWrite,
  systemPrincipal,
  TenantConfigService,
  type Tx,
  tenantZone,
  tenantZoneOf,
} from '@hykr/core';
import { type Database, schema } from '@hykr/db';
import type { Lang } from '@hykr/i18n';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Subscription } from 'rxjs';
import { type Metering, setMetering, type UsageInput } from '../../metering.js';
import { type Assessment, assess, type Counter, headroomOf, refusalFor } from './budget.js';
import {
  type CreditsPlanResolved,
  creditsConfig,
  creditsFor,
  priceFor,
  resolvePlan,
} from './config.js';
import { creditPurchaseProviders, FrameworkMeters, type MeterDef, meters } from './meters.js';
import {
  CREDIT_OPS,
  CreditPurchaseRequested,
  CreditsCredited,
  CreditsSettingsChanged,
  METER_JOB,
  moveCredits,
  PURCHASE_JOB,
  settlePurchase,
  toPurchase,
} from './writes.js';

const { usageEvents, usageCounters, creditWallets, creditLedger, creditAlerts, creditPurchases } =
  schema;

const log = new Logger('Credits');

/** The owner registerOp keeps, so a second start in one process registers nothing new. */
const OWNER = { feature: 'credits' };

/**
 * credits.threshold: a cap (the budget, 'credits', or a meter's limit) passed a level this
 * period. Stored in the outbox and published, so the application's notification and any
 * subscriber can tell the people who manage the credits.
 */
export class CreditsThreshold implements NamedEvent {
  readonly eventName = 'credits.threshold';
  readonly resourceType = 'credits';
  constructor(readonly row: CreditsThresholdRow) {}
}

/** A period of a business's plan: its unit and bounds. */
export interface Period {
  unit: CreditsPlanResolved['period'];
  start: Date;
  end: Date;
}

/** The calendar period `now` falls in, in the business's zone (Postgres does the calendar). */
async function periodOf(conn: Conn, unit: Period['unit'], zone: string): Promise<Period> {
  const { rows } = await conn.execute<{ start: Date | string; end: Date | string }>(sql`
    select date_trunc(${unit}, now() at time zone ${zone}) at time zone ${zone} as start,
      (date_trunc(${unit}, now() at time zone ${zone}) + ('1 ' || ${unit})::interval)
        at time zone ${zone} as "end"`);
  return { unit, start: new Date(rows[0].start), end: new Date(rows[0].end) };
}

/** The plan's refusal when the settings cannot be read: everything stops (fail closed). */
const UNAVAILABLE: UsageRefusal = {
  rule: 'credits_unavailable',
  reason: "This business's credits settings are not valid",
  cap: 'credits',
};

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Credits and caps for every business: it meters what each one uses (the channels report through
 * the `Metering` slot, the turn hook through `turnHook`), prices it, debits the wallet past the
 * period's allowance, raises alerts as caps fill, and refuses what a paused business may not do.
 * Reads go straight to the counters, so every process agrees at once.
 */
@Injectable()
export class CreditsService implements Metering, OnModuleInit, OnModuleDestroy {
  private readonly db: Database;
  private subscription?: Subscription;
  private readonly warned = new Set<string>();

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    private readonly tenants: TenantConfigService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {
    this.db = core.db;
  }

  /** The database, for the turn hook's lookups. */
  get database(): Database {
    return this.db;
  }

  /** The business's name and settings (cached). */
  tenantInfo(tenantId: string) {
    return this.tenants.get(tenantId);
  }

  /**
   * A paused business's customer: a person takes the conversation (it shows in the back office),
   * with what they asked and what they were told in the thread.
   */
  async handOver(
    contact: { id: string; tenantId: string; userId: string | null },
    said: { message: string; reply: string; lang?: Lang },
  ) {
    // Loaded when used: the channel's services read the configuration when they load.
    const [{ HandoffService }, { ThreadsService }] = await Promise.all([
      import('../../channels/handoff/handoff.service.js'),
      import('../../modules/threads/threads.service.js'),
    ]);
    const handoff = await this.ref
      .get(HandoffService, { strict: false })
      .open(contact, 'assistant_paused');
    const threads = this.ref.get(ThreadsService, { strict: false });
    for (const [role, text] of [
      ['user', said.message],
      ['assistant', said.reply],
    ] as const)
      await threads.append({
        threadId: handoff.threadId,
        role,
        text,
        channel: 'whatsapp',
        lang: said.lang ?? null,
      });
  }

  /** A malformed CREDITS_CONFIG stops the start here. */
  onModuleInit() {
    const config = creditsConfig();
    for (const [name, factory] of Object.entries(CREDIT_OPS)) registerOp(name, factory, OWNER);
    setMetering(this);
    setCredits(this);
    log.log(
      `Credits: ${config.currency ?? 'no currency (metered at no cost)'}; ${
        config.defaults.enforce
          ? 'businesses are on credits by default'
          : 'nothing capped by default'
      }`,
    );
    this.subscription = this.events.subscribe((event) => {
      if (event instanceof CreditsSettingsChanged) {
        this.tenants.invalidate(event.tenantId);
        this.reconcile(event.tenantId).catch((e) => log.warn(`reconcile: ${reasonOf(e)}`));
      }
      if (event instanceof CreditsCredited)
        this.reconcile(event.row.tenantId).catch((e) => log.warn(`reconcile: ${reasonOf(e)}`));
      // A purchase recorded here or replayed from an approval: its provider starts it.
      if (event instanceof CreditPurchaseRequested)
        this.checkout(event.row.id).catch((e) => log.error(`checkout: ${reasonOf(e)}`));
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
    setMetering(undefined);
    setCredits(undefined);
  }

  /* ── Plans and assessments ───────────────────────────────────────────── */

  /**
   * The business's effective plan, and the zone its periods are in (`tenantZone`). Settings
   * that do not parse throw.
   */
  async planOf(tenantId: string): Promise<{ plan: CreditsPlanResolved; zone: string }> {
    const { settings } = await this.tenants.get(tenantId);
    return {
      plan: resolvePlan(creditsConfig(), settings.credits),
      zone: tenantZone(settings),
    };
  }

  /**
   * The plan from the deployment alone, for recording when the business's settings fail; its
   * periods are still the business's (the zone is read alone, so the counters stay the same).
   */
  private async fallbackPlan(
    tenantId: string,
  ): Promise<{ plan: CreditsPlanResolved; zone: string }> {
    return {
      plan: resolvePlan(creditsConfig(), undefined),
      zone: await tenantZoneOf(this.db, tenantId),
    };
  }

  /** This period's counters and the wallet, read in `conn` (a transaction keeps them in step). */
  private async assessIn(
    conn: Conn,
    tenantId: string,
    plan: CreditsPlanResolved,
    zone: string,
  ): Promise<{ period: Period; a: Assessment; walletCurrency: string | null }> {
    const period = await periodOf(conn, plan.period, zone);
    const counters: Counter[] = await conn
      .select({
        meter: usageCounters.meter,
        quantity: usageCounters.quantity,
        cost: usageCounters.cost,
      })
      .from(usageCounters)
      .where(
        and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.periodStart, period.start)),
      );
    const [wallet] = await conn
      .select({ balance: creditWallets.balance, currency: creditWallets.currency })
      .from(creditWallets)
      .where(eq(creditWallets.tenantId, tenantId));
    const balance = wallet && wallet.currency === plan.currency ? wallet.balance : null;
    return { period, a: assess(plan, counters, balance), walletCurrency: wallet?.currency ?? null };
  }

  async assessment(tenantId: string) {
    const { plan, zone } = await this.planOf(tenantId);
    return { plan, ...(await this.assessIn(this.db, tenantId, plan, zone)) };
  }

  /* ── The Metering slot ───────────────────────────────────────────────── */

  /** May this business use this meter now? Fails closed when its settings do not parse. */
  async check(a: {
    tenantId: string;
    meter: string;
    variant?: string | null;
  }): Promise<UsageRefusal | null> {
    return (await this.checkMany(a.tenantId, [{ meter: a.meter, variant: a.variant }]))[0] ?? null;
  }

  /** The first refusal among these meters, from one look at the counters. */
  async checkMany(
    tenantId: string,
    uses: readonly { meter: string; variant?: string | null }[],
  ): Promise<(UsageRefusal | null)[]> {
    const defs = uses.map((u) => ({ def: this.meter(u.meter), variant: u.variant }));
    let plan: CreditsPlanResolved;
    let zone: string;
    try {
      ({ plan, zone } = await this.planOf(tenantId));
    } catch (e) {
      log.warn(`Settings of business ${tenantId} do not parse: ${reasonOf(e)}`);
      // Fail closed, except for what is never paused (a reply, a code, an approval request).
      const fallback = resolvePlan(creditsConfig(), undefined);
      return defs.map((d) =>
        !d.def || (d.def.pausable && !d.def.pausable(d.variant, fallback)) ? null : UNAVAILABLE,
      );
    }
    // Nothing caps these uses: no need to read the counters.
    const free = (d: (typeof defs)[number]) =>
      !d.def || (d.def.pausable && !d.def.pausable(d.variant, plan));
    if ((!plan.enforce && !plan.override) || defs.every(free)) return defs.map(() => null);
    const { a } = await this.assessIn(this.db, tenantId, plan, zone);
    return defs.map((d) => (d.def ? refusalFor(a, d.def, d.variant) : null));
  }

  async headroom(a: { tenantId: string; meter: string }): Promise<number | undefined> {
    const def = this.meter(a.meter);
    if (!def) return undefined;
    let plan: CreditsPlanResolved;
    let zone: string;
    try {
      ({ plan, zone } = await this.planOf(a.tenantId));
    } catch {
      return 0;
    }
    if (!plan.enforce && !plan.override) return undefined;
    const { a: assessed } = await this.assessIn(this.db, a.tenantId, plan, zone);
    return headroomOf(assessed, def, priceFor(plan.prices, def.name));
  }

  /** A registered meter, or undefined (logged once): an unknown one is never capped. */
  private meter(name: string): MeterDef | undefined {
    const def = meters.get(name);
    if (!def && !this.warned.has(`meter:${name}`)) {
      this.warned.add(`meter:${name}`);
      log.warn(`No meter is called ${name}: its uses are not recorded or capped`);
    }
    return def;
  }

  /**
   * What tokens a turn used cost, in credits: the price for `tokens.<model>` or `tokens`, else
   * the model's own price (MODEL_PROVIDERS) plus the markup when it is in the credits currency,
   * else nothing.
   */
  tokenCost(plan: CreditsPlanResolved, model: string | undefined, usage: TokenUsage): number {
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    const set = priceFor(plan.prices, 'tokens', model);
    if (set !== undefined) return creditsFor(set, tokens, FrameworkMeters.tokens.per);
    const own = model ? modelPrice(model) : undefined;
    if (own && plan.currency && own.currency === plan.currency) {
      const exact =
        ((usage.inputTokens ?? 0) * own.inputPerMillion +
          (usage.outputTokens ?? 0) * (own.outputPerMillion ?? 0)) /
        1_000_000;
      return creditsFor(exact * (1 + plan.markupPercent / 100), 1);
    }
    if (model && !this.warned.has(`model:${model}`)) {
      this.warned.add(`model:${model}`);
      log.warn(
        own
          ? `${model} is priced in ${own.currency}, not the credits currency: its tokens cost nothing`
          : `${model} has no price: its tokens cost nothing (set CREDITS_CONFIG.prices.tokens)`,
      );
    }
    return 0;
  }

  /**
   * Record uses, in one transaction: each a usage row (once per `ref`) added to its period's
   * counter, priced; for a business on credits, the part past the allowance debited from the
   * wallet (locked, so uses never race), and every level now reached stored and announced once.
   * Never throws: metering must not fail what was already done.
   */
  async record(input: UsageInput | readonly UsageInput[]): Promise<void> {
    const uses = (Array.isArray(input) ? input : [input]) as readonly UsageInput[];
    const byTenant = new Map<string, UsageInput[]>();
    for (const u of uses) {
      if (!u.tenantId || !(u.quantity > 0) || !this.meter(u.meter)) continue;
      byTenant.set(u.tenantId, [...(byTenant.get(u.tenantId) ?? []), u]);
    }
    for (const [tenantId, list] of byTenant)
      await this.recordFor(tenantId, list).catch((e) =>
        log.error(`Recording usage for business ${tenantId} failed: ${reasonOf(e)}`),
      );
  }

  private async recordFor(tenantId: string, uses: readonly UsageInput[]) {
    let resolved: { plan: CreditsPlanResolved; zone: string };
    try {
      resolved = await this.planOf(tenantId);
    } catch (e) {
      log.warn(
        `Settings of business ${tenantId} do not parse; metering on the defaults: ${reasonOf(e)}`,
      );
      resolved = await this.fallbackPlan(tenantId);
    }
    const { plan, zone } = resolved;
    const events = await this.db.transaction(async (tx) => {
      const enforced = plan.enforce && !!plan.currency;
      let walletOk = false;
      if (enforced && plan.currency) {
        // The wallet row, locked: this business's uses are debited one at a time.
        await tx
          .insert(creditWallets)
          .values({ tenantId, currency: plan.currency })
          .onConflictDoNothing();
        const [wallet] = await tx
          .select({ currency: creditWallets.currency })
          .from(creditWallets)
          .where(eq(creditWallets.tenantId, tenantId))
          .for('update');
        walletOk = wallet?.currency === plan.currency;
        if (!walletOk) log.error(`The wallet of business ${tenantId} is not in ${plan.currency}`);
      }
      const period = await periodOf(tx, plan.period, zone);
      const [{ spent: spentBefore } = { spent: 0 }] = await tx
        .select({ spent: sql<number>`coalesce(sum(${usageCounters.cost}), 0)::bigint` })
        .from(usageCounters)
        .where(
          and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.periodStart, period.start)),
        );
      let spent = Number(spentBefore);
      for (const use of uses) {
        const def = this.meter(use.meter) as MeterDef;
        const cost =
          use.cost ??
          (() => {
            const price = priceFor(plan.prices, def.name, use.variant);
            return price === undefined ? 0 : creditsFor(price, use.quantity, def.per);
          })();
        const [row] = await tx
          .insert(usageEvents)
          .values({
            tenantId,
            meter: def.name,
            variant: use.variant ?? null,
            quantity: Math.ceil(use.quantity),
            cost,
            currency: plan.currency,
            periodStart: period.start,
            subject: use.subject ?? null,
            runId: use.runId ?? null,
            channel: use.channel ?? null,
            source: use.source,
            ref: use.ref ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: usageEvents.id });
        // Recorded already (a retried report): it counts once.
        if (!row) continue;
        await tx
          .insert(usageCounters)
          .values({
            tenantId,
            periodStart: period.start,
            meter: def.name,
            quantity: Math.ceil(use.quantity),
            cost,
          })
          .onConflictDoUpdate({
            target: [usageCounters.tenantId, usageCounters.periodStart, usageCounters.meter],
            set: {
              quantity: sql`${usageCounters.quantity} + excluded.quantity`,
              cost: sql`${usageCounters.cost} + excluded.cost`,
              updatedAt: sql`now()`,
            },
          });
        const before = spent;
        spent += cost;
        // The allowance first, then the wallet.
        const beyond = Math.max(0, spent - plan.allowance) - Math.max(0, before - plan.allowance);
        if (enforced && walletOk && beyond > 0 && plan.currency)
          await moveCredits(tx, {
            tenantId,
            currency: plan.currency,
            amount: -beyond,
            kind: 'debit',
            ref: row.id,
            note: `${def.name}${use.variant ? ` ${use.variant}` : ''} × ${use.quantity}`,
            actor: { kind: 'system', id: METER_JOB },
          });
      }
      if (!plan.enforce) return [];
      const { a } = await this.assessIn(tx, tenantId, plan, zone);
      return this.announce(tx, tenantId, period, a, false);
    });
    for (const event of events) this.events.publish(event);
  }

  /**
   * Store each level reached now that has no row this period, as an alert row and a
   * `credits.threshold` event in the outbox. With `rearm`, a level no longer reached loses its
   * row, so it is announced again the next time.
   */
  private async announce(
    tx: Tx,
    tenantId: string,
    period: Period,
    a: Assessment,
    rearm: boolean,
  ): Promise<NamedEvent[]> {
    const where = and(
      eq(creditAlerts.tenantId, tenantId),
      eq(creditAlerts.periodStart, period.start),
    );
    if (rearm) {
      const kept = new Set(a.levels.map((l) => `${l.cap}/${l.level}`));
      const rows = await tx
        .select({ id: creditAlerts.id, cap: creditAlerts.cap, level: creditAlerts.level })
        .from(creditAlerts)
        .where(where);
      const gone = rows.filter((r) => !kept.has(`${r.cap}/${r.level}`)).map((r) => r.id);
      if (gone.length) await tx.delete(creditAlerts).where(inArray(creditAlerts.id, gone));
    }
    if (!a.levels.length) return [];
    const added = await tx
      .insert(creditAlerts)
      .values(
        a.levels.map((l) => ({
          tenantId,
          periodStart: period.start,
          cap: l.cap,
          level: l.level,
          usedPercent: Math.floor(l.usedPercent),
          threshold: l.threshold,
        })),
      )
      .onConflictDoNothing()
      .returning();
    if (!added.length) return [];
    const recipients = await this.managersOf(tx, tenantId);
    const events = added.map(
      (r) =>
        new CreditsThreshold({
          id: r.id,
          tenantId,
          cap: r.cap,
          level: r.level as 'alert' | 'pause',
          usedPercent: r.usedPercent,
          threshold: r.threshold,
          periodStart: period.start.toISOString(),
          recipients,
        }),
    );
    await recordEvents(tx, {
      principal: systemPrincipal({ tenantId, job: METER_JOB }),
      events,
    });
    for (const r of added)
      log.log(`business=${tenantId} ${r.cap} reached ${r.level} (${r.usedPercent}%)`);
    return events;
  }

  /** The people whose roles hold `credits.manage` in this business. */
  private async managersOf(conn: Conn, tenantId: string): Promise<string[]> {
    const members = await conn
      .select({ userId: schema.memberships.userId, roles: schema.memberships.roles })
      .from(schema.memberships)
      .where(eq(schema.memberships.tenantId, tenantId));
    return members
      .filter((m) => capabilitiesOf(m.roles).includes(CreditsManageCapability.name))
      .map((m) => m.userId)
      .sort();
  }

  /**
   * Bring the alert rows in line with the business's caps now: levels reached and not yet
   * announced are announced (a plan that lowered the allowance), and levels no longer reached
   * are re-armed (a top-up). After a top-up, a grant, a plan change, and on the sweep.
   */
  async reconcile(tenantId: string): Promise<void> {
    let resolved: { plan: CreditsPlanResolved; zone: string };
    try {
      resolved = await this.planOf(tenantId);
    } catch {
      return;
    }
    const { plan, zone } = resolved;
    const events = await this.db.transaction(async (tx) => {
      const { period, a } = await this.assessIn(tx, tenantId, plan, zone);
      return this.announce(tx, tenantId, period, plan.enforce ? a : { ...a, levels: [] }, true);
    });
    for (const event of events) this.events.publish(event);
  }

  /** The sweep: every business with use this period or a wallet, reconciled. */
  async sweep(): Promise<number> {
    const { rows } = await this.db.execute<{ tenant_id: string }>(sql`
      select tenant_id from ${usageCounters} where period_start > now() - interval '32 days'
      union select tenant_id from ${creditWallets}`);
    for (const { tenant_id } of rows)
      await this.reconcile(tenant_id).catch((e) =>
        log.warn(`sweep: business ${tenant_id}: ${reasonOf(e)}`),
      );
    return rows.length;
  }

  /* ── Reads ───────────────────────────────────────────────────────────── */

  /** The business's credits this period. Amounts only with `manage`. */
  async status(tenantId: string, manage: boolean): Promise<CreditsStatus> {
    let plan: CreditsPlanResolved;
    let zone: string;
    try {
      ({ plan, zone } = await this.planOf(tenantId));
    } catch {
      throw new ServiceUnavailableException({
        error: UNAVAILABLE.rule,
        reason: UNAVAILABLE.reason,
      });
    }
    const { period, a } = await this.assessIn(this.db, tenantId, plan, zone);
    const paused =
      plan.override?.mode === 'pause' || (plan.enforce && a.budget?.pause)
        ? refusalFor(a, FrameworkMeters.tokens)
        : null;
    const status: CreditsStatus = {
      enforced: plan.enforce,
      period: {
        unit: period.unit,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
      },
      paused: paused?.cap === 'credits' ? paused : null,
      usedPercent: a.budget?.usedPercent ?? null,
      alertAt: plan.alertAt,
      pauseAt: plan.pauseAt,
      meters: meters.all().map((def): MeterStatus => {
        const counter = a.quantities.get(def.name);
        const limit = a.limits.get(def.name);
        return {
          meter: def.name,
          unit: def.unit,
          quantity: counter?.quantity ?? 0,
          ...(limit ? { limit: limit.limit, usedPercent: limit.usedPercent } : {}),
          paused: !!limit?.pause,
          ...(manage ? { cost: counter?.cost ?? 0 } : {}),
        };
      }),
    };
    if (!manage) return status;
    return {
      ...status,
      currency: plan.currency,
      allowance: plan.allowance,
      spent: a.spent,
      ...(a.budget ? { balance: a.budget.balance, remaining: a.budget.remaining } : {}),
      prices: plan.prices,
      override: plan.override,
    };
  }

  /** Wallet entries, newest first: `limit` of them before `before` (an ISO time). */
  async ledger(tenantId: string, opts: { before?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const before = opts.before ? new Date(opts.before) : undefined;
    const rows = await this.db
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.tenantId, tenantId),
          before && !Number.isNaN(before.getTime()) ? lt(creditLedger.at, before) : undefined,
        ),
      )
      .orderBy(desc(creditLedger.at), desc(creditLedger.id))
      .limit(limit + 1);
    const items: LedgerEntry[] = rows.slice(0, limit).map((r) => ({
      id: r.id,
      kind: r.kind as LedgerEntry['kind'],
      amount: r.amount,
      balanceAfter: r.balanceAfter,
      currency: r.currency,
      ref: r.ref,
      note: r.note,
      actor: { kind: r.actorKind, id: r.actorId },
      at: r.at.toISOString(),
    }));
    return { items, next: rows.length > limit ? (items.at(-1)?.at ?? null) : null };
  }

  /** One of this business's purchases; another business's is not found. */
  async purchase(tenantId: string, id: string): Promise<CreditPurchase> {
    const [row] = await this.db
      .select()
      .from(creditPurchases)
      .where(and(eq(creditPurchases.id, id), eq(creditPurchases.tenantId, tenantId)));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such purchase' });
    return toPurchase(row);
  }

  /** What this business used, by meter and day, from `from` (inclusive) to `to`. */
  async usage(tenantId: string, from: Date, to: Date) {
    return this.db
      .select({
        meter: usageEvents.meter,
        day: sql<string>`to_char(date_trunc('day', ${usageEvents.at}), 'YYYY-MM-DD')`,
        quantity: sql<number>`sum(${usageEvents.quantity})::bigint`.mapWith(Number),
        cost: sql<number>`sum(${usageEvents.cost})::bigint`.mapWith(Number),
      })
      .from(usageEvents)
      .where(
        and(eq(usageEvents.tenantId, tenantId), gte(usageEvents.at, from), lt(usageEvents.at, to)),
      )
      .groupBy(usageEvents.meter, sql`2`)
      .orderBy(sql`2`, usageEvents.meter);
  }

  /* ── Purchases ───────────────────────────────────────────────────────── */

  /**
   * Start a requested purchase with its provider, once (whoever gets here first: the request
   * that made it, or the event of an approval's replay). An instant outcome settles it at once.
   */
  async checkout(id: string): Promise<void> {
    const [row] = await this.db
      .update(creditPurchases)
      .set({ status: 'open' })
      .where(and(eq(creditPurchases.id, id), eq(creditPurchases.status, 'requested')))
      .returning();
    if (!row) return;
    const provider = creditPurchaseProviders.get(row.provider);
    let started: Awaited<ReturnType<NonNullable<typeof provider>['start']>>;
    try {
      if (!provider) throw new Error(`No purchase provider is called ${row.provider}`);
      started = await provider.start({
        purchase: {
          id: row.id,
          tenantId: row.tenantId,
          amount: row.amount,
          currency: row.currency,
        },
        userId: row.createdBy,
      });
    } catch (e) {
      log.error(`purchase ${id}: ${reasonOf(e)}`);
      await this.settlePurchase(id, { status: 'failed', reason: reasonOf(e).slice(0, 500) });
      return;
    }
    await this.db
      .update(creditPurchases)
      .set({
        ...(started.ref ? { providerRef: started.ref } : {}),
        ...(started.checkoutUrl ? { checkoutUrl: started.checkoutUrl } : {}),
      })
      .where(eq(creditPurchases.id, id));
    if (started.status)
      await this.settlePurchase(id, {
        status: started.status,
        ...(started.ref ? { ref: started.ref } : {}),
        ...(started.reason ? { reason: started.reason } : {}),
      });
  }

  /**
   * A purchase's outcome, from its provider (a connector's verified webhook calls this): paid
   * tops the wallet up, failed does not. Through runWrite as the provider (system), audited.
   * Settling one that is settled already returns it as it is.
   */
  async settlePurchase(
    id: string,
    outcome: { status: 'paid' | 'failed'; ref?: string; reason?: string },
  ): Promise<CreditPurchase> {
    const [row] = await this.db.select().from(creditPurchases).where(eq(creditPurchases.id, id));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such purchase' });
    if (row.status === 'paid' || row.status === 'failed') return toPurchase(row);
    try {
      const { events } = await runWrite(
        this.db,
        {
          principal: systemPrincipal({ tenantId: row.tenantId, job: PURCHASE_JOB }),
          requestId: randomUUID(),
        },
        settlePurchase(),
        { purchaseId: id, ...outcome },
      );
      for (const event of events) this.events.publish(event);
    } catch (e) {
      // Settled by someone else in between: it is as they left it.
      if (!(e instanceof ConflictException)) throw e;
    }
    const [after] = await this.db.select().from(creditPurchases).where(eq(creditPurchases.id, id));
    return toPurchase(after);
  }
}

/* ── The turn hook's service ─────────────────────────────────────────────── */

let credits: CreditsService | undefined;

/** The running service (the turn hook reads it); set while the credits feature is loaded. */
export function setCredits(service?: CreditsService) {
  credits = service;
}
export const creditsService = () => credits;
