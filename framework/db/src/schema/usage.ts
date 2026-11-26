// Credits and caps (A3): what each business used (metered and priced), per period, and its
// prepaid wallet. Amounts are credits: whole minor units of the deployment's credits currency.
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { app, id } from './base.js';
import { tenantColumn, tenants } from './tenancy.js';

const credits = (name: string) => bigint(name, { mode: 'number' });

/**
 * One use of something metered, append-only: a turn's tokens, its tool calls, a message sent, a
 * voice session. `ref` makes a use recorded twice (a retried report) count once.
 */
export const usageEvents = app.table(
  'usage_events',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** 'tokens', 'tool_calls', 'messages', 'voice_seconds', or a meter a feature added. */
    meter: text('meter').notNull(),
    /** The model for tokens, a template's category for messages. */
    variant: text('variant'),
    /** In the meter's base unit. */
    quantity: credits('quantity').notNull(),
    /** Its price in credits (0 when unpriced). */
    cost: credits('cost').notNull().default(0),
    currency: text('currency'),
    /** The period it counts in (its start, in the business's time zone). */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    /** Whom it was for: 'user:<id>' or 'contact:<id>'. */
    subject: text('subject'),
    runId: text('run_id'),
    channel: text('channel'),
    /** What recorded it: 'turn', 'outbound', 'voice', or a feature's name. */
    source: text('source').notNull(),
    ref: text('ref'),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('usage_events_ref_idx')
      .on(table.tenantId, table.meter, table.ref)
      .where(sql`${table.ref} is not null`),
    index('usage_events_tenant_at_idx').on(table.tenantId, table.at),
  ],
);

/** What a business used of one meter in one period, added to atomically with each use. */
export const usageCounters = app.table(
  'usage_counters',
  {
    tenantId: tenantColumn(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    meter: text('meter').notNull(),
    quantity: credits('quantity').notNull().default(0),
    cost: credits('cost').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.periodStart, table.meter] })],
);

/** A business's prepaid credits. Its row is locked while a use is debited, one at a time. */
export const creditWallets = app.table('credit_wallets', {
  tenantId: text('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** Never changes once the wallet exists. */
  currency: text('currency').notNull(),
  /** May go below zero by one use's overshoot. */
  balance: credits('balance').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Every change to a wallet, append-only: top-ups and grants in, debits out. */
export const creditLedger = app.table(
  'credit_ledger',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** 'topup', 'grant' or 'debit'. */
    kind: text('kind').notNull(),
    /** Positive in, negative out. */
    amount: credits('amount').notNull(),
    balanceAfter: credits('balance_after').notNull(),
    currency: text('currency').notNull(),
    /** The purchase or the use it was for. */
    ref: text('ref'),
    note: text('note'),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('credit_ledger_tenant_at_idx').on(table.tenantId, table.at)],
);

/**
 * A cap (the budget, 'credits', or a meter) that passed a level ('alert' or 'pause') in a
 * period: one row each, so a level is announced once. Deleted when the cap falls back below
 * the level (a top-up), so it is announced again the next time.
 */
export const creditAlerts = app.table(
  'credit_alerts',
  {
    id: id(),
    tenantId: tenantColumn(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    cap: text('cap').notNull(),
    level: text('level').notNull(),
    usedPercent: integer('used_percent').notNull(),
    threshold: integer('threshold').notNull(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('credit_alerts_once_idx').on(
      table.tenantId,
      table.periodStart,
      table.cap,
      table.level,
    ),
  ],
);

/** Credits bought through a purchase provider: requested, open (checkout), then paid or failed. */
export const creditPurchases = app.table(
  'credit_purchases',
  {
    id: id(),
    tenantId: tenantColumn(),
    amount: credits('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('requested'),
    /** The purchase provider's name. */
    provider: text('provider').notNull(),
    /** The provider's own id for it. */
    providerRef: text('provider_ref'),
    checkoutUrl: text('checkout_url'),
    /** Why it failed. */
    reason: text('reason'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [index('credit_purchases_tenant_idx').on(table.tenantId, table.createdAt)],
);
