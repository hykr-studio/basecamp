import { CurrencyCode, type Money, MoneySettings } from '@hykr/contracts';
import { schema } from '@hykr/db';
import { currencyExponent } from '@hykr/i18n';
import { eq } from 'drizzle-orm';
import { tenantZone } from '../tenants/time-zone.js';
import type { Conn } from '../tokens.js';

/** ISO 4217's own code for "no currency": what money is in when nobody chose one. */
export const NO_CURRENCY = 'XXX';

let deployment: string | undefined;

/** The deployment's default currency (DEFAULT_CURRENCY), set once when the server starts. */
export function setDefaultCurrency(code: string | undefined): void {
  deployment = code === undefined || code === '' ? undefined : CurrencyCode.parse(code);
}

/** The currency of a business that set none: the deployment's, else XXX. */
export const defaultCurrency = (): string => deployment ?? NO_CURRENCY;

/** A business's money settings with its currency resolved and its time zone beside them. */
export interface ResolvedMoney {
  currency: string;
  /** The currency's minor-unit exponent: 2 for EUR, 0 for JPY. */
  exponent: number;
  fyStartMonth: number;
  timeZone: string;
  amounts: Record<string, Money>;
  bands: Record<string, Money[]>;
}

/**
 * A business's money settings, read now (in the caller's transaction, if given): its currency
 * (its own, else the deployment's, else XXX), financial-year start, time zone (`tenantZone`),
 * named amounts and bands. Only the `money` section and the time zone are read, so another section's bad
 * value does not stop a write.
 */
export async function tenantMoney(conn: Conn, tenantId: string): Promise<ResolvedMoney> {
  const [row] = await conn
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  const stored = (row?.settings ?? {}) as Record<string, unknown>;
  const money = MoneySettings.parse(stored.money);
  const timeZone = tenantZone(stored);
  const currency = money.currency ?? defaultCurrency();
  return {
    currency,
    exponent: currencyExponent(currency),
    fyStartMonth: money.fyStartMonth,
    timeZone,
    amounts: money.amounts,
    bands: money.bands,
  };
}
