import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';
import { CurrencyCode, type Money, Money as MoneySchema } from '../framework/money.js';
import { defineSettingsSection } from './sections.js';

/**
 * A business's money settings. Every value is the business's own: the framework sets no
 * currency, no amounts and no bands. `amounts` and `bands` are keyed by the application
 * ('orders.approval'), which reads them in its own rules.
 */
export const MoneySettings = z
  .object({
    /** The business's currency. Unset: the deployment's DEFAULT_CURRENCY, else XXX. */
    currency: CurrencyCode.optional(),
    /** The month its financial year starts, 1-12. 1: the calendar year. */
    fyStartMonth: z.number().int().min(1).max(12).default(1),
    /** Named amounts the application compares against: a limit, a threshold. */
    amounts: z.record(z.string(), MoneySchema).default({}),
    /** Named bands: ascending upper bounds, each band's top. */
    bands: z.record(z.string(), z.array(MoneySchema)).default({}),
  })
  .default({ fyStartMonth: 1, amounts: {}, bands: {} });
export type MoneySettings = z.infer<typeof MoneySettings>;

declare module './sections.js' {
  interface TenantSettingsSections {
    money: MoneySettings;
  }
}

export const MoneySection = defineSettingsSection('money', MoneySettings, { editable: true });

// GET /api/money (the money feature in @hykr/api).
reserveRoutes('money');

/**
 * A named amount the business set, if any: from its `money` settings section, or from
 * `tenantMoney` (@hykr/core), which carries the same `amounts`.
 */
export const moneyAmount = (
  money: { amounts?: Readonly<Record<string, Money>> } | undefined,
  key: string,
): Money | undefined => money?.amounts?.[key];

/**
 * Is the amount above the limit? Fails closed: no limit, or a limit in another currency,
 * counts as exceeded, so whatever the limit guards still asks.
 */
export function exceeds(amount: Money, limit: Money | undefined): boolean {
  if (!limit || limit.currency !== amount.currency) return true;
  return amount.minor > limit.minor;
}

/**
 * Which band an amount falls in: the index of the first upper bound it does not pass, or the
 * number of bounds when it passes them all. A bound in another currency is never matched, so
 * such an amount lands in the top band.
 */
export function moneyBand(amount: Money, bounds: readonly Money[] | undefined): number {
  const list = bounds ?? [];
  const i = list.findIndex((b) => b.currency === amount.currency && amount.minor <= b.minor);
  return i === -1 ? list.length : i;
}
