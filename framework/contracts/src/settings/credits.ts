import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import { defineCapability } from '../roles.js';
import { defineSettingsSection } from './sections.js';

/**
 * A meter's name: what is counted ('tokens', 'tool_calls', 'messages', 'voice_seconds', or one
 * a feature or module adds). Lower case words joined by '_'.
 */
export const MeterName = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'A meter: lower case letters, digits and _');
export type MeterName = z.infer<typeof MeterName>;

/**
 * What a price is keyed by: a meter ('messages'), or a meter and one of its variants
 * ('messages.marketing', 'tokens.<model ref>'). The variant's price wins over the meter's.
 */
export const PriceKey = z
  .string()
  .max(240)
  .regex(/^[a-z][a-z0-9_]*(\.\S+)?$/, 'A price key: "<meter>" or "<meter>.<variant>"');

/** How usage is counted: per calendar day, week (from Monday) or month, in the business's zone. */
export const CreditPeriod = z.enum(['day', 'week', 'month']);
export type CreditPeriod = z.infer<typeof CreditPeriod>;

const Percent = z.number().int().min(1).max(200);

/**
 * A business's plan: whether it is on credits, what each period includes, its thresholds and
 * limits, and its prices. Every field is optional: the effective plan is the framework's neutral
 * defaults, then the deployment's (`CREDITS_CONFIG.defaults`), then these. Amounts are credits:
 * whole minor units of the deployment's credits currency.
 */
export const CreditsPlan = z
  .object({
    /** Budget, limits, alerts and pauses apply. Off: usage is metered and priced, nothing more. */
    enforce: z.boolean().optional(),
    /** Credits included each period, spent before the wallet. */
    allowance: z.number().int().min(0).optional(),
    period: CreditPeriod.optional(),
    /** Per cent of a cap at which the business is alerted. */
    alertAt: Percent.optional(),
    /** Per cent of a cap at which it is paused. */
    pauseAt: Percent.optional(),
    /** Per meter, the most that may be used in a period, in the meter's base unit. */
    limits: z.record(MeterName, z.number().int().min(0)).optional(),
    /** Credits per meter's pricing unit, by price key; over the deployment's, key by key. */
    prices: z.record(PriceKey, z.number().finite().min(0)).optional(),
    /** Message variants (a template's category) not sent while the business is paused. */
    pauseMessages: z.array(z.string().min(1).max(40)).max(20).optional(),
  })
  .strict();
export type CreditsPlan = z.infer<typeof CreditsPlan>;

/**
 * An operator's say over the caps until a time: `run` lets everything through (still metered),
 * `pause` stops the business as if it had nothing left. Past `until`, it is ignored.
 */
export const CreditsOverride = z
  .object({
    mode: z.enum(['run', 'pause']),
    until: z.iso.datetime({ offset: true }).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type CreditsOverride = z.infer<typeof CreditsOverride>;

/** The `credits` settings section as stored: the plan and the operator's override. */
export const CreditsSettingsFields = CreditsPlan.extend({
  override: CreditsOverride.optional(),
});

export const CreditsSettings = CreditsSettingsFields.prefault({});
export type CreditsSettings = z.infer<typeof CreditsSettings>;

declare module './sections.js' {
  interface TenantSettingsSections {
    credits: CreditsSettings;
  }
}

export const CreditsSection = defineSettingsSection('credits', CreditsSettings);

/** See whether the business is paused and how much of each cap it has used (no amounts). */
export const CreditsViewCapability = defineCapability({
  name: 'credits.view',
  label: {
    en: "See the business's usage",
    hi: 'व्यवसाय का उपयोग देखें',
    te: 'వ్యాపార వినియోగాన్ని చూడండి',
  },
  roles: ['owner', 'admin', 'ops', 'staff'],
  supportable: true,
});

/** See amounts, the ledger and purchases, buy credits and set the alert threshold. */
export const CreditsManageCapability = defineCapability({
  name: 'credits.manage',
  label: {
    en: "Manage the business's credits",
    hi: 'व्यवसाय के क्रेडिट प्रबंधित करें',
    te: 'వ్యాపార క్రెడిట్‌లను నిర్వహించండి',
  },
  roles: ['owner', 'admin'],
  supportable: false,
});

/**
 * Why something metered may not run now: the budget is spent, a meter's limit is reached, the
 * operator paused the business, or its credits settings do not parse (fail closed).
 */
export const UsageRefusalRule = z.enum([
  'credits_exhausted',
  'usage_limit_reached',
  'credits_suspended',
  'credits_unavailable',
]);
export type UsageRefusalRule = z.infer<typeof UsageRefusalRule>;

export interface UsageRefusal {
  rule: UsageRefusalRule;
  reason: string;
  /** The cap that is reached: 'credits' (the budget) or a meter's name. */
  cap: string;
}

/** One meter in a period, as `GET /api/credits` shows it. */
export interface MeterStatus {
  meter: string;
  /** The meter as people call it, in the reader's language (`?lang=`): 'Assistant actions'. */
  label: string;
  unit: string;
  /** Used this period, in base units. */
  quantity: number;
  limit?: number;
  /** Of the limit, when there is one. */
  usedPercent?: number;
  /** Its limit is reached: what it meters is refused (not under the operator's `run`). */
  paused: boolean;
  /** Why, when it is paused: its limit's rule and reason. */
  refusal?: UsageRefusal;
  /** Credits spent on it this period (`credits.manage` only). */
  cost?: number;
}

/** `GET /api/credits`: the business's credits this period. Amounts with `credits.manage` only. */
export interface CreditsStatus {
  enforced: boolean;
  period: { unit: CreditPeriod; start: string; end: string };
  /**
   * Why the assistant's turns are refused now: the operator's pause, the budget (then voice and
   * the paused message variants are refused too), or a `tokens` or `tool_calls` limit. Null:
   * turns run. A limit on another meter refuses only that meter's use: see `meters`.
   */
  paused: UsageRefusal | null;
  /**
   * Of the budget (allowance + wallet), at most 100: one use past what was left takes the wallet
   * below zero and reads as all of it. Null without a budget.
   */
  usedPercent: number | null;
  alertAt: number;
  pauseAt: number;
  meters: MeterStatus[];
  currency?: string | null;
  allowance?: number;
  spent?: number;
  balance?: number;
  remaining?: number;
  prices?: Record<string, number>;
  override?: CreditsOverride | null;
}

export const LedgerKind = z.enum(['topup', 'grant', 'debit']);
export type LedgerKind = z.infer<typeof LedgerKind>;

/** One wallet entry: credits in (top-up, grant) or out (debit), and the balance after it. */
export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  /** Positive in, negative out. */
  amount: number;
  balanceAfter: number;
  currency: string;
  /** What it was for: a purchase, a use. */
  ref: string | null;
  /** Words written with it (a grant's, a top-up's). A debit has none: see `use`. */
  note: string | null;
  /**
   * A debit's use, worded when read: its meter (`meter` as the code names it, `label` as people
   * call it, in the reader's language) and how much, in the meter's base unit.
   */
  use?: { meter: string; label: string; quantity: number };
  actor: { kind: string; id: string };
  at: string;
}

export const PurchaseStatus = z.enum(['requested', 'open', 'paid', 'failed']);
export type PurchaseStatus = z.infer<typeof PurchaseStatus>;

/** A purchase of credits through a purchase provider. */
export interface CreditPurchase {
  id: string;
  amount: number;
  currency: string;
  status: PurchaseStatus;
  provider: string;
  /** Where the person pays, while it is open. */
  checkoutUrl: string | null;
  reason: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** `POST /api/credits/purchases`. */
export const CreditPurchaseInput = z
  .object({
    amount: z.number().int().min(1).max(1_000_000_000),
    provider: z.string().min(1).max(60).optional(),
  })
  .strict();
export type CreditPurchaseInput = z.infer<typeof CreditPurchaseInput>;

/** `PUT /api/credits/alerts`: the business's own alert threshold. */
export const CreditAlertsInput = z.object({ alertAt: Percent }).strict();

/** `POST /api/credits/operator/:tenantId/grants`. */
export const CreditGrantInput = z
  .object({
    amount: z.number().int().min(1).max(1_000_000_000),
    note: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * The row of a `credits.threshold` event: a cap (the budget or a meter) passed a level this
 * period. It names nobody: a notification tells the people who manage the credits with the
 * recipient `{ capability: CreditsManageCapability.name }`, which notify dispatch expands with
 * the business's roles (its own, and its edits of declared ones) when it sends.
 */
export interface CreditsThresholdRow {
  id: string;
  tenantId: string;
  cap: string;
  level: 'alert' | 'pause';
  usedPercent: number;
  threshold: number;
  periodStart: string;
  /**
   * A meter's cap as people call it, in each of the application's languages (the label the meter
   * declares, or the framework's phrase for its own): an alert never says 'tool_calls'. Absent
   * for the budget (`cap: 'credits'`), which the application words itself.
   */
  label?: Labels;
  [key: string]: unknown;
}
