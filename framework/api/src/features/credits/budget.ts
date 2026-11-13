// How much of its caps a business has used this period, and what that refuses. Pure: the
// service reads the counters and the wallet, this does the arithmetic.
import type { UsageRefusal } from '@hykr/contracts';
import { type Lang, t } from '@hykr/i18n';
import type { CreditsPlanResolved } from './config.js';
import { FrameworkMeters, type MeterDef, meterLabel } from './meters.js';

/** One meter's use this period. */
export interface Counter {
  meter: string;
  quantity: number;
  cost: number;
}

/** The budget: the period's allowance plus the wallet. */
export interface Budget {
  allowance: number;
  spent: number;
  balance: number;
  /** What is left before the wallet is empty: unspent allowance plus the balance. */
  remaining: number;
  /** spent + remaining: the allowance plus what the wallet held for this period. */
  total: number;
  usedPercent: number;
  alert: boolean;
  pause: boolean;
}

/** A meter with a limit this period. */
export interface Limit {
  quantity: number;
  limit: number;
  usedPercent: number;
  alert: boolean;
  pause: boolean;
}

/** A level a cap has reached: 'credits' (the budget) or a meter's name. */
export interface Level {
  cap: string;
  level: 'alert' | 'pause';
  usedPercent: number;
  threshold: number;
}

export interface Assessment {
  plan: CreditsPlanResolved;
  spent: number;
  /** Null when the business is not on credits or the deployment has no currency. */
  budget: Budget | null;
  limits: Map<string, Limit>;
  /** Every level reached now (on credits only). */
  levels: Level[];
  quantities: Map<string, Counter>;
}

/** Per cent of `of`, to one decimal; nothing to use up counts as all of it used. */
const percent = (used: number, of: number) => (of > 0 ? Math.round((used / of) * 1000) / 10 : 100);

/** At or past `threshold` per cent: integers, so 80 of 100 is exactly 80%. */
const reached = (used: number, of: number, threshold: number) =>
  of <= 0 ? true : used * 100 >= threshold * of;

export function assess(
  plan: CreditsPlanResolved,
  counters: readonly Counter[],
  balance: number | null,
): Assessment {
  const quantities = new Map(counters.map((c) => [c.meter, c]));
  const spent = counters.reduce((sum, c) => sum + c.cost, 0);
  let budget: Budget | null = null;
  if (plan.enforce && plan.currency) {
    const wallet = balance ?? 0;
    const remaining = Math.max(0, plan.allowance - spent) + wallet;
    const total = spent + remaining;
    budget = {
      allowance: plan.allowance,
      spent,
      balance: wallet,
      remaining,
      total,
      usedPercent: percent(spent, total),
      alert: reached(spent, total, plan.alertAt),
      pause: reached(spent, total, plan.pauseAt),
    };
  }
  const limits = new Map<string, Limit>();
  if (plan.enforce)
    for (const [meter, limit] of Object.entries(plan.limits)) {
      const quantity = quantities.get(meter)?.quantity ?? 0;
      limits.set(meter, {
        quantity,
        limit,
        usedPercent: percent(quantity, limit),
        alert: reached(quantity, limit, plan.alertAt),
        pause: reached(quantity, limit, plan.pauseAt),
      });
    }
  const levels: Level[] = [];
  const add = (cap: string, x: { alert: boolean; pause: boolean; usedPercent: number }) => {
    if (x.alert)
      levels.push({ cap, level: 'alert', usedPercent: x.usedPercent, threshold: plan.alertAt });
    if (x.pause)
      levels.push({ cap, level: 'pause', usedPercent: x.usedPercent, threshold: plan.pauseAt });
  };
  if (budget) add('credits', budget);
  for (const [meter, limit] of limits) add(meter, limit);
  return { plan, spent, budget, limits, levels, quantities };
}

/**
 * Whether a use of this meter (and variant) is refused now. The operator's override wins: `run`
 * lets it through, `pause` stops it. Otherwise a business on credits is stopped by its budget or
 * by the meter's limit. A variant its meter never pauses (a reply, a code) always goes. The
 * reason is in `lang`, the reader's (English when the caller has none).
 */
export function refusalFor(
  a: Assessment,
  meter: MeterDef,
  variant?: string | null,
  lang: Lang = 'en',
): UsageRefusal | null {
  const { plan } = a;
  if (meter.pausable && !meter.pausable(variant, plan)) return null;
  if (plan.override?.mode === 'run') return null;
  if (plan.override?.mode === 'pause')
    return {
      rule: 'credits_suspended',
      reason: t(lang, 'credits.reason.operator', { reason: plan.override.reason }),
      cap: 'credits',
    };
  if (!plan.enforce) return null;
  if (a.budget?.pause)
    return {
      rule: 'credits_exhausted',
      reason: t(lang, 'credits.reason.budget', { percent: a.budget.usedPercent }),
      cap: 'credits',
    };
  return limitRefusal(a, meter, lang);
}

/**
 * Whether this meter's own limit refuses its use now, whatever the budget: what the credits
 * screen shows beside the meter. The operator's `run` lets everything through.
 */
export function limitRefusal(
  a: Assessment,
  meter: MeterDef,
  lang: Lang = 'en',
): UsageRefusal | null {
  if (a.plan.override?.mode === 'run') return null;
  const limit = a.limits.get(meter.name);
  if (!limit?.pause) return null;
  return {
    rule: 'usage_limit_reached',
    // The meter as people call it: never its name in the code ('tool_calls').
    reason: t(lang, 'credits.reason.limit', { what: meterLabel(meter, lang) }),
    cap: meter.name,
  };
}

/**
 * What an assistant's turn spends, in the order a refusal is reported: its model tokens, then
 * its tool calls. A turn, and an agent's call outside MCP, is refused when either is.
 */
export const TURN_METERS: readonly MeterDef[] = [FrameworkMeters.tokens, FrameworkMeters.toolCalls];

/**
 * Why turns are refused now, or null when they run: the operator's pause, the budget, or a
 * limit on what a turn spends. The turn hook, the agent guard and the credits status share it.
 */
export const turnRefusal = (a: Assessment, lang: Lang = 'en'): UsageRefusal | null =>
  TURN_METERS.reduce<UsageRefusal | null>(
    (r, meter) => r ?? refusalFor(a, meter, undefined, lang),
    null,
  );

/**
 * How many base units of this meter may still be used before the business is paused, by its
 * limit and by its credits at the meter's price. Undefined: nothing caps it.
 */
export function headroomOf(
  a: Assessment,
  meter: MeterDef,
  price: number | undefined,
): number | undefined {
  const { plan } = a;
  if (plan.override?.mode === 'run') return undefined;
  if (plan.override?.mode === 'pause') return 0;
  if (!plan.enforce) return undefined;
  let left = Number.POSITIVE_INFINITY;
  const limit = a.limits.get(meter.name);
  if (limit) left = Math.min(left, Math.ceil((plan.pauseAt * limit.limit) / 100) - limit.quantity);
  if (a.budget && price && price > 0) {
    // Spending moves credits from remaining to spent: their sum, the total, stays the same.
    const credits = Math.ceil((plan.pauseAt * a.budget.total) / 100) - a.budget.spent;
    left = Math.min(left, Math.floor((credits * (meter.per ?? 1)) / price));
  }
  return left === Number.POSITIVE_INFINITY ? undefined : Math.max(0, left);
}
