import { localeOf } from './format.js';
import type { Lang } from './lang.js';

/**
 * Words for amounts of money, in the person's language, from whole minor units and an ISO 4217
 * currency. Intl knows each currency's symbol, its name in each language, its grouping and its
 * minor-unit exponent; nothing here names a currency.
 */
type Amount = { readonly minor: number; readonly currency: string };

const exponents = new Map<string, number>();

/** How many decimals the currency's minor unit has: 2 for EUR, 0 for JPY, 3 for BHD. */
export function currencyExponent(currency: string): number {
  let exp = exponents.get(currency);
  if (exp === undefined) {
    exp = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits as number;
    exponents.set(currency, exp);
  }
  return exp;
}

/** The amount as an exact decimal string ("1234.50"), which Intl formats without a float. */
function decimal({ minor, currency }: Amount): string {
  const exp = currencyExponent(currency);
  const digits = Math.abs(minor)
    .toString()
    .padStart(exp + 1, '0');
  const sign = minor < 0 ? '-' : '';
  return exp === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

function format(m: Amount, lang: Lang, options: Intl.NumberFormatOptions): string {
  const exp = currencyExponent(m.currency);
  const f = new Intl.NumberFormat(localeOf(lang), {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
    ...options,
  });
  // A decimal string keeps every digit where the engine takes one (Intl.NumberFormat v3);
  // elsewhere it is read as a number, as before.
  return f.format(decimal(m) as unknown as number);
}

/** "€1,234.50", in the language's own grouping and digits. */
export function moneyText(m: Amount, lang: Lang = 'en'): string {
  return format(m, lang, {});
}

/** The form to say aloud: the currency's name instead of its symbol ("1,234.50 euros"). */
export function spokenMoney(m: Amount, lang: Lang = 'en'): string {
  return format(m, lang, { currencyDisplay: 'name' });
}
