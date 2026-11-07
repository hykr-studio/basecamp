// The credits writes, each through runWrite (validated, idempotent, authorized, audited,
// parkable, replayable): the operator's plan, override and grants; the business's alert
// threshold and purchases; a purchase's settlement, which tops the wallet up.
import {
  atLeast,
  CreditAlertsInput,
  CreditGrantInput,
  type CreditPurchase,
  CreditPurchaseInput,
  CreditsManageCapability,
  CreditsOverride,
  CreditsPlan,
  type Principal,
} from '@hykr/contracts';
import { allow, deny, type NamedEvent, type Touched, type Tx, type WriteOp } from '@hykr/core';
import { schema } from '@hykr/db';
import { can, userIdOf } from '@hykr/policy';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { creditsConfig, NEUTRAL_PLAN } from './config.js';
import { creditPurchaseProviders, meters } from './meters.js';

const { tenants, creditWallets, creditLedger, creditPurchases } = schema;

/** The operations, as audited and as parked. */
export const SET_CREDITS_PLAN = 'credits.plan.set';
export const SET_CREDITS_OVERRIDE = 'credits.override.set';
export const SET_CREDIT_ALERTS = 'credits.alerts.set';
export const GRANT_CREDITS = 'credits.grant';
export const BUY_CREDITS = 'credits.purchase';
export const SETTLE_PURCHASE = 'credits.purchase.settle';

/** Who the operator's writes run as (systemPrincipal's job), and a provider's settlements. */
export const OPERATOR_JOB = 'credits.operator';
export const PURCHASE_JOB = 'credits.purchase';
/** Who records usage, debits and alerts. */
export const METER_JOB = 'credits.meter';

type Stored = Record<string, unknown>;
type PurchaseRow = typeof creditPurchases.$inferSelect;

/* ── Events ──────────────────────────────────────────────────────────────── */

/** credits.settings.changed: a business's plan or override changed. */
export class CreditsSettingsChanged implements NamedEvent {
  readonly eventName = 'credits.settings.changed';
  readonly resourceType = 'tenant';
  readonly row: { id: string; tenantId: string; credits: Stored };
  constructor(
    readonly tenantId: string,
    credits: Stored,
  ) {
    this.row = { id: tenantId, tenantId, credits };
  }
}

/** credits.wallet.credited: a top-up or a grant reached the wallet. */
export class CreditsCredited implements NamedEvent {
  readonly eventName = 'credits.wallet.credited';
  readonly resourceType = 'credit_wallet';
  constructor(
    readonly row: {
      id: string;
      tenantId: string;
      kind: 'topup' | 'grant';
      amount: number;
      balance: number;
      currency: string;
    },
  ) {}
}

/** credits.purchase.requested: a purchase was recorded; its provider starts it next. */
export class CreditPurchaseRequested implements NamedEvent {
  readonly eventName = 'credits.purchase.requested';
  readonly resourceType = 'credit_purchase';
  constructor(readonly row: PurchaseRow) {}
}

/** credits.purchase.settled: paid or failed. */
export class CreditPurchaseSettled implements NamedEvent {
  readonly eventName = 'credits.purchase.settled';
  readonly resourceType = 'credit_purchase';
  constructor(readonly row: PurchaseRow) {}
}

/* ── Shared parts ────────────────────────────────────────────────────────── */

/** A purchase as it leaves the API. */
export const toPurchase = (row: PurchaseRow): CreditPurchase => ({
  id: row.id,
  amount: row.amount,
  currency: row.currency,
  status: row.status as CreditPurchase['status'],
  provider: row.provider,
  checkoutUrl: row.status === 'open' ? row.checkoutUrl : null,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
  settledAt: row.settledAt?.toISOString() ?? null,
});

const operatorOnly = (p: Principal) =>
  p.actor.kind === 'system' && p.actor.id === OPERATOR_JOB
    ? allow('operator', 'The operator may')
    : deny('operator_only', "Only the platform's operator can do this");

/** A person, signed in, with `credits.manage`. */
function manager(p: Principal, what: string) {
  if (p.actor.kind !== 'user') return deny('people_only', `Only a person can ${what}`);
  if (!can(p, CreditsManageCapability))
    return deny('credits_manage', `Only people who manage the business's credits can ${what}`);
  if (!atLeast(p.assurance, 'session'))
    return deny('needs_assurance', `Sign in to the app to ${what}`);
  return allow('credits_manage', 'Manages the credits');
}

/** The business's settings row, locked, and its stored `credits` section as it is. */
async function loadSettings(tx: Tx, tenantId: string | undefined) {
  const [row] = await tx
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId ?? ''))
    .for('update');
  if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such business' });
  const stored = (row.settings as Stored | null)?.credits;
  const credits = stored && typeof stored === 'object' ? (stored as Stored) : {};
  return { tenantId: tenantId as string, before: credits };
}

/** Write only the `credits` key: the other sections stay as they are. */
async function saveCredits(tx: Tx, tenantId: string, credits: Stored) {
  await tx
    .update(tenants)
    .set({
      settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{credits}', ${JSON.stringify(credits)}::jsonb)`,
    })
    .where(eq(tenants.id, tenantId));
}

const meterOf = (key: string) => key.split('.')[0];

/**
 * What is wrong with a plan: limits and prices for meters nobody registered, and an alert
 * threshold above the pause.
 */
export function planProblems(credits: Stored): string[] {
  const parsed = CreditsPlan.safeParse(
    Object.fromEntries(Object.entries(credits).filter(([k]) => k !== 'override')),
  );
  if (!parsed.success)
    return parsed.error.issues.map((i) => `${i.path.join('.') || '(plan)'}: ${i.message}`);
  const plan = parsed.data;
  const problems: string[] = [];
  for (const key of Object.keys(plan.limits ?? {}))
    if (!meters.has(key)) problems.push(`limits.${key}: no meter is called ${key}`);
  for (const key of Object.keys(plan.prices ?? {}))
    if (!meters.has(meterOf(key)))
      problems.push(`prices.${key}: no meter is called ${meterOf(key)}`);
  const defaults = creditsConfig().defaults;
  const alertAt = plan.alertAt ?? defaults.alertAt ?? NEUTRAL_PLAN.alertAt;
  const pauseAt = plan.pauseAt ?? defaults.pauseAt ?? NEUTRAL_PLAN.pauseAt;
  if (alertAt > pauseAt)
    problems.push(`alertAt (${alertAt}) must not be above pauseAt (${pauseAt})`);
  return problems;
}

/** Credits into (or out of) the wallet, with its ledger row: the wallet row locked first. */
export async function moveCredits(
  tx: Tx,
  a: {
    tenantId: string;
    currency: string;
    amount: number;
    kind: 'topup' | 'grant' | 'debit';
    ref?: string | null;
    note?: string | null;
    actor: { kind: string; id: string };
  },
) {
  await tx
    .insert(creditWallets)
    .values({ tenantId: a.tenantId, currency: a.currency })
    .onConflictDoNothing();
  const [wallet] = await tx
    .select()
    .from(creditWallets)
    .where(eq(creditWallets.tenantId, a.tenantId))
    .for('update');
  if (wallet.currency !== a.currency)
    throw new ConflictException({
      error: 'currency_mismatch',
      reason: `The wallet holds ${wallet.currency}, not ${a.currency}`,
    });
  const [after] = await tx
    .update(creditWallets)
    .set({ balance: sql`${creditWallets.balance} + ${a.amount}`, updatedAt: sql`now()` })
    .where(eq(creditWallets.tenantId, a.tenantId))
    .returning({ balance: creditWallets.balance });
  const [entry] = await tx
    .insert(creditLedger)
    .values({
      tenantId: a.tenantId,
      kind: a.kind,
      amount: a.amount,
      balanceAfter: after.balance,
      currency: a.currency,
      ref: a.ref ?? null,
      note: a.note ?? null,
      actorKind: a.actor.kind,
      actorId: a.actor.id,
    })
    .returning({ id: creditLedger.id });
  return { before: wallet.balance, after: after.balance, entryId: entry.id };
}

/** The deployment's credits currency, or 503: nothing can be bought or granted without one. */
function currencyOrFail(): string {
  const currency = creditsConfig().currency;
  if (!currency)
    throw new ServiceUnavailableException({
      error: 'credits_not_configured',
      reason: 'Set CREDITS_CONFIG.currency to sell or grant credits',
    });
  return currency;
}

/* ── The operator's writes ───────────────────────────────────────────────── */

/** `PUT /api/credits/operator/:tenantId/settings`: the whole plan (unknown keys refused). */
export const PlanInput = CreditsPlan;

type SettingsLoaded = { tenantId: string; before: Stored };

/**
 * The operator replaces the business's plan. The override stays, and so does the business's own
 * alert threshold unless the plan sets one.
 */
export const setCreditsPlan = (): WriteOp<CreditsPlan, SettingsLoaded, Stored> => ({
  name: SET_CREDITS_PLAN,
  kind: 'command',
  resourceType: 'tenant',
  resourceId: (_i, loaded) => loaded.tenantId,
  input: PlanInput,
  load: (tx, p) => loadSettings(tx, p.tenantId),
  authorize: operatorOnly,
  summarize: (plan) => `Credits plan: ${JSON.stringify(plan)}`,
  run: async ({ tx, input, loaded }) => {
    const credits: Stored = {
      ...input,
      ...(input.alertAt === undefined && loaded.before.alertAt !== undefined
        ? { alertAt: loaded.before.alertAt }
        : {}),
      ...(loaded.before.override ? { override: loaded.before.override } : {}),
    };
    const problems = planProblems(credits);
    if (problems.length) throw new ConflictException({ error: 'invalid_plan', problems });
    await saveCredits(tx, loaded.tenantId, credits);
    return {
      value: credits,
      touched: [
        {
          type: 'tenant',
          id: loaded.tenantId,
          change: 'updated',
          before: { credits: loaded.before },
          after: { credits },
        },
      ],
      events: [new CreditsSettingsChanged(loaded.tenantId, credits)],
    };
  },
  present: (value) => value,
});

/** `PUT /api/credits/operator/:tenantId/override`: set it, or clear it with null. */
export const OverrideInput = z.object({ override: CreditsOverride.nullable() }).strict();
type OverrideInput = z.infer<typeof OverrideInput>;

export const setCreditsOverride = (): WriteOp<OverrideInput, SettingsLoaded, Stored> => ({
  name: SET_CREDITS_OVERRIDE,
  kind: 'command',
  resourceType: 'tenant',
  resourceId: (_i, loaded) => loaded.tenantId,
  input: OverrideInput,
  load: (tx, p) => loadSettings(tx, p.tenantId),
  authorize: operatorOnly,
  summarize: ({ override: o }) =>
    o
      ? `Credits override: ${o.mode}${o.until ? ` until ${o.until}` : ''} (${o.reason})`
      : 'Clear the credits override',
  run: async ({ tx, input, loaded }) => {
    const { override: _gone, ...rest } = loaded.before;
    const credits: Stored = input.override ? { ...rest, override: input.override } : rest;
    await saveCredits(tx, loaded.tenantId, credits);
    return {
      value: credits,
      touched: [
        {
          type: 'tenant',
          id: loaded.tenantId,
          change: 'updated',
          before: { credits: loaded.before },
          after: { credits },
        },
      ],
      events: [new CreditsSettingsChanged(loaded.tenantId, credits)],
    };
  },
  present: (value) => value,
});

type GrantInput = z.infer<typeof CreditGrantInput>;

/** `POST /api/credits/operator/:tenantId/grants`: credits given, with a note. */
export const grantCredits = (): WriteOp<
  GrantInput,
  { tenantId: string; currency: string },
  unknown
> => ({
  name: GRANT_CREDITS,
  kind: 'command',
  resourceType: 'credit_wallet',
  resourceId: (_i, loaded) => loaded.tenantId,
  input: CreditGrantInput,
  load: async (_tx, p) => ({ tenantId: p.tenantId as string, currency: currencyOrFail() }),
  authorize: operatorOnly,
  summarize: (input, loaded) => `Grant ${input.amount} credits (${loaded.currency}): ${input.note}`,
  run: async ({ tx, principal, input, loaded }) => {
    const moved = await moveCredits(tx, {
      tenantId: loaded.tenantId,
      currency: loaded.currency,
      amount: input.amount,
      kind: 'grant',
      note: input.note,
      actor: principal.actor,
    });
    const row = {
      id: moved.entryId,
      tenantId: loaded.tenantId,
      kind: 'grant' as const,
      amount: input.amount,
      balance: moved.after,
      currency: loaded.currency,
    };
    return {
      value: { balance: moved.after, currency: loaded.currency },
      touched: [
        {
          type: 'credit_wallet',
          id: loaded.tenantId,
          change: 'updated',
          before: { balance: moved.before },
          after: { balance: moved.after },
        },
      ],
      events: [new CreditsCredited(row)],
    };
  },
  present: (value) => value,
});

/* ── The business's writes ───────────────────────────────────────────────── */

type AlertsInput = z.infer<typeof CreditAlertsInput>;

/** `PUT /api/credits/alerts`: the business's own alert threshold, at most its pause. */
export const setCreditAlerts = (): WriteOp<AlertsInput, SettingsLoaded, Stored> => ({
  name: SET_CREDIT_ALERTS,
  kind: 'command',
  resourceType: 'tenant',
  resourceId: (_i, loaded) => loaded.tenantId,
  input: CreditAlertsInput,
  load: (tx, p) => loadSettings(tx, p.tenantId),
  authorize: (p) => manager(p, 'change when the business is alerted about its credits'),
  summarize: (input) => `Alert at ${input.alertAt}% of the credits`,
  run: async ({ tx, input, loaded }) => {
    const credits: Stored = { ...loaded.before, alertAt: input.alertAt };
    const problems = planProblems(credits);
    if (problems.length) throw new ConflictException({ error: 'invalid_plan', problems });
    await saveCredits(tx, loaded.tenantId, credits);
    return {
      value: { alertAt: input.alertAt },
      touched: [
        {
          type: 'tenant',
          id: loaded.tenantId,
          change: 'updated',
          before: { credits: { alertAt: loaded.before.alertAt ?? null } },
          after: { credits: { alertAt: input.alertAt } },
        },
      ],
      events: [new CreditsSettingsChanged(loaded.tenantId, credits)],
    };
  },
  present: (value) => value,
});

type PurchaseLoaded = { tenantId: string; currency: string; provider: string };

/** The provider a purchase goes through: the one named, or the only one. */
export function providerFor(name?: string): string {
  const all = creditPurchaseProviders.all();
  if (!all.length)
    throw new ServiceUnavailableException({
      error: 'purchases_unavailable',
      reason: 'Credits cannot be bought here: no purchase provider is set up',
    });
  if (name) {
    if (!creditPurchaseProviders.has(name))
      throw new BadRequestException({
        error: 'unknown_provider',
        reason: `No purchase provider is called ${name}`,
      });
    return name;
  }
  if (all.length > 1)
    throw new BadRequestException({
      error: 'provider_required',
      reason: `Name a purchase provider: ${all.map((p) => p.name).join(', ')}`,
    });
  return all[0].name;
}

/**
 * `POST /api/credits/purchases`: a person who manages the credits asks to buy some. It records
 * the purchase; its provider is started once it commits (`CreditsService.checkout`).
 */
export const buyCredits = (): WriteOp<CreditPurchaseInput, PurchaseLoaded, PurchaseRow> => ({
  name: BUY_CREDITS,
  kind: 'command',
  resourceType: 'credit_purchase',
  resourceId: () => null,
  input: CreditPurchaseInput,
  load: async (_tx, p, input) => ({
    tenantId: p.tenantId as string,
    currency: currencyOrFail(),
    provider: providerFor(input.provider),
  }),
  authorize: (p) => manager(p, 'buy credits'),
  summarize: (input, loaded) =>
    `Buy ${input.amount} credits (${loaded.currency}) through ${loaded.provider}`,
  run: async ({ tx, principal, input, loaded }) => {
    const [row] = await tx
      .insert(creditPurchases)
      .values({
        tenantId: loaded.tenantId,
        amount: input.amount,
        currency: loaded.currency,
        provider: loaded.provider,
        createdBy: userIdOf(principal) ?? principal.actor.id,
      })
      .returning();
    return {
      value: row,
      touched: [{ type: 'credit_purchase', id: row.id, change: 'created', after: toPurchase(row) }],
      events: [new CreditPurchaseRequested(row)],
    };
  },
  present: (row) => toPurchase(row),
});

/** A purchase's outcome, as its provider reports it. */
export const SettleInput = z
  .object({
    purchaseId: z.string().min(1),
    status: z.enum(['paid', 'failed']),
    ref: z.string().max(200).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
type SettleInput = z.infer<typeof SettleInput>;

/** Paid: the wallet is topped up by the amount. Failed: nothing moves. Settled once. */
export const settlePurchase = (): WriteOp<SettleInput, PurchaseRow, PurchaseRow> => ({
  name: SETTLE_PURCHASE,
  kind: 'command',
  resourceType: 'credit_purchase',
  resourceId: (input) => input.purchaseId,
  input: SettleInput,
  load: async (tx, p, input) => {
    const [row] = await tx
      .select()
      .from(creditPurchases)
      .where(
        and(
          eq(creditPurchases.id, input.purchaseId),
          eq(creditPurchases.tenantId, p.tenantId ?? ''),
        ),
      )
      .for('update');
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such purchase' });
    return row;
  },
  authorize: (p) =>
    p.actor.kind === 'system' && p.actor.id === PURCHASE_JOB
      ? allow('purchase_provider', 'The purchase provider reports it')
      : deny('provider_only', "Only the purchase's provider settles it"),
  summarize: (input, row) => `Purchase of ${row.amount} credits ${input.status}`,
  run: async ({ tx, principal, input, loaded }) => {
    if (loaded.status === 'paid' || loaded.status === 'failed')
      throw new ConflictException({ error: 'already_settled', status: loaded.status });
    const [row] = await tx
      .update(creditPurchases)
      .set({
        status: input.status,
        settledAt: sql`now()`,
        ...(input.ref ? { providerRef: input.ref } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      })
      .where(eq(creditPurchases.id, loaded.id))
      .returning();
    const touched: Touched[] = [
      {
        type: 'credit_purchase',
        id: row.id,
        change: 'updated',
        before: toPurchase(loaded),
        after: toPurchase(row),
      },
    ];
    const events: NamedEvent[] = [new CreditPurchaseSettled(row)];
    if (input.status === 'paid') {
      const moved = await moveCredits(tx, {
        tenantId: row.tenantId,
        currency: row.currency,
        amount: row.amount,
        kind: 'topup',
        ref: row.id,
        note: `${row.provider}${row.providerRef ? ` ${row.providerRef}` : ''}`,
        actor: principal.actor,
      });
      touched.push({
        type: 'credit_wallet',
        id: row.tenantId,
        change: 'updated',
        before: { balance: moved.before },
        after: { balance: moved.after },
      });
      events.push(
        new CreditsCredited({
          id: moved.entryId,
          tenantId: row.tenantId,
          kind: 'topup',
          amount: row.amount,
          balance: moved.after,
          currency: row.currency,
        }),
      );
    }
    return { value: row, touched, events };
  },
  present: (row) => toPurchase(row),
});

/** Every op a parked approval may replay, by name. */
export const CREDIT_OPS = {
  [SET_CREDITS_PLAN]: setCreditsPlan,
  [SET_CREDITS_OVERRIDE]: setCreditsOverride,
  [GRANT_CREDITS]: grantCredits,
  [SET_CREDIT_ALERTS]: setCreditAlerts,
  [BUY_CREDITS]: buyCredits,
  [SETTLE_PURCHASE]: settlePurchase,
} as const;
