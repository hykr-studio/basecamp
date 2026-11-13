// The deployment's credits configuration (CREDITS_CONFIG) and a business's effective plan: the
// framework's neutral defaults, then the deployment's, then the business's settings. Pure: the
// service passes in what it read.
import {
  type CreditPeriod,
  type CreditsOverride,
  CreditsPlan,
  type CreditsSettings,
  CurrencyCode,
  PriceKey,
} from '@hykr/contracts';
import { z } from 'zod';

/** CREDITS_CONFIG: what this deployment charges in, its prices and the plan every business starts on. */
export const CreditsConfig = z
  .object({
    /** ISO 4217: a credit is one minor unit of it. Unset: uses are metered at no cost. */
    currency: CurrencyCode.optional(),
    /** Credits per meter's pricing unit, by '<meter>' or '<meter>.<variant>'. */
    prices: z.record(PriceKey, z.number().finite().min(0)).default({}),
    /** Added to a model's own price (MODEL_PROVIDERS), per cent. */
    markupPercent: z.number().finite().min(0).max(10_000).default(0),
    /** The plan of a business that sets nothing itself. */
    defaults: CreditsPlan.default({}),
  })
  .strict();
export type CreditsConfig = z.infer<typeof CreditsConfig>;

/** CREDITS_CONFIG is malformed: every problem, so one deploy fixes them all. */
export class CreditsConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`CREDITS_CONFIG is not valid:\n- ${problems.join('\n- ')}`);
    this.name = 'CreditsConfigError';
  }
}

/** CREDITS_CONFIG, checked. Unset or blank: no currency, no prices, the neutral plan. */
export function parseCreditsConfig(raw: string | undefined): CreditsConfig {
  if (!raw?.trim()) return CreditsConfig.parse({});
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new CreditsConfigError([`not JSON: ${e instanceof Error ? e.message : e}`]);
  }
  const parsed = CreditsConfig.safeParse(json);
  if (!parsed.success)
    throw new CreditsConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  const { defaults } = parsed.data;
  const order = thresholdProblem(
    defaults.alertAt ?? NEUTRAL_PLAN.alertAt,
    defaults.pauseAt ?? NEUTRAL_PLAN.pauseAt,
  );
  if (order) throw new CreditsConfigError([`defaults: ${order}`]);
  return parsed.data;
}

let cached: { raw: string | undefined; config: CreditsConfig } | undefined;

/** This process's CREDITS_CONFIG, parsed once per value (tests change it). */
export function creditsConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const raw = env.CREDITS_CONFIG;
  if (cached && cached.raw === raw) return cached.config;
  const config = parseCreditsConfig(raw);
  cached = { raw, config };
  return config;
}

/** A business's plan with every field decided, and the deployment's currency and markup. */
export interface CreditsPlanResolved {
  enforce: boolean;
  allowance: number;
  period: CreditPeriod;
  alertAt: number;
  pauseAt: number;
  limits: Record<string, number>;
  prices: Record<string, number>;
  pauseMessages: string[];
  /** The operator's override, while it holds. */
  override: CreditsOverride | null;
  currency: string | null;
  markupPercent: number;
}

/**
 * The framework's plan: metered, nothing capped, and the thresholds a business on credits gets
 * unless its plan says otherwise (alert at 80 per cent of a cap, pause at 100).
 */
export const NEUTRAL_PLAN = {
  enforce: false,
  allowance: 0,
  period: 'month' as CreditPeriod,
  alertAt: 80,
  pauseAt: 100,
  limits: {} as Record<string, number>,
  prices: {} as Record<string, number>,
  pauseMessages: [] as string[],
};

/** An alert is an early warning: it must come before the pause, never at it. */
export const thresholdProblem = (alertAt: number, pauseAt: number): string | undefined =>
  alertAt >= pauseAt ? `alertAt (${alertAt}) must be below pauseAt (${pauseAt})` : undefined;

/** The override, if it still holds at `now`. */
export function activeOverride(
  o: CreditsOverride | undefined | null,
  now: Date,
): CreditsOverride | null {
  if (!o) return null;
  if (o.until && Date.parse(o.until) <= now.getTime()) return null;
  return o;
}

/** Each field: the business's, else the deployment's, else the framework's. Maps merge by key. */
export function resolvePlan(
  config: CreditsConfig,
  settings: CreditsSettings | undefined,
  now = new Date(),
): CreditsPlanResolved {
  const d = config.defaults;
  const s = settings ?? {};
  return {
    enforce: s.enforce ?? d.enforce ?? NEUTRAL_PLAN.enforce,
    allowance: s.allowance ?? d.allowance ?? NEUTRAL_PLAN.allowance,
    period: s.period ?? d.period ?? NEUTRAL_PLAN.period,
    alertAt: s.alertAt ?? d.alertAt ?? NEUTRAL_PLAN.alertAt,
    pauseAt: s.pauseAt ?? d.pauseAt ?? NEUTRAL_PLAN.pauseAt,
    limits: { ...d.limits, ...s.limits },
    prices: { ...config.prices, ...d.prices, ...s.prices },
    pauseMessages: s.pauseMessages ?? d.pauseMessages ?? NEUTRAL_PLAN.pauseMessages,
    override: activeOverride(s.override, now),
    currency: config.currency ?? null,
    markupPercent: config.markupPercent,
  };
}

/** A meter's price for this variant: the variant's own, else the meter's. */
export function priceFor(
  prices: Readonly<Record<string, number>>,
  meter: string,
  variant?: string | null,
): number | undefined {
  if (variant) {
    const own = prices[`${meter}.${variant}`];
    if (own !== undefined) return own;
  }
  return prices[meter];
}

/** Credits for `quantity` base units at `price` per `per` units: rounded up, never negative. */
export function creditsFor(price: number, quantity: number, per = 1): number {
  // A hair above a whole number is float noise (0.1 * 3), not a fraction of a credit.
  return Math.max(0, Math.ceil((quantity * price) / per - 1e-9));
}
