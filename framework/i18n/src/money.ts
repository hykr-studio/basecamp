import { type Lang, localeOf } from './lang.js';

/**
 * Words for amounts of money, in the person's language, from whole minor units and an ISO 4217
 * currency. Intl knows each currency's symbol, its name in each language, its grouping and its
 * minor-unit exponent; nothing here names a currency.
 */
type Amount = { readonly minor: number; readonly currency: string };

const exponents = new Map<string, number>();

const FORMAT = /^[A-Z]{3}$/;

/** The currencies Intl lists, plus XXX; null where the runtime cannot list them. */
let known: ReadonlySet<string> | null | undefined;

/** The currencies this runtime's Intl lists, or null when it lists none (no ICU data, Hermes). */
function listCurrencies(): ReadonlySet<string> | null {
  const list = (Intl as { supportedValuesOf?: (key: 'currency') => string[] }).supportedValuesOf;
  try {
    const codes = typeof list === 'function' ? list('currency') : [];
    return codes.length ? new Set([...codes, 'XXX']) : null;
  } catch {
    return null;
  }
}

/**
 * Can this runtime list its currencies? Where it cannot, `knownCurrency` takes any three capital
 * letters, so the server refuses to start without it (`assertConfig`): its check must fail
 * closed. Asked afresh each time, not remembered.
 */
export const canListCurrencies = (): boolean => listCurrencies() !== null;

/**
 * Is this a currency: one the runtime's Intl lists (ISO 4217), or XXX, ISO's code for "no
 * currency" (what a business that set none counts in)? Writes and configuration refuse any other
 * code; reads and formatting take one, so a row stored with it still shows. Where the runtime
 * cannot list its currencies (Hermes on a device), any three capital letters pass: the server,
 * which can (it does not start otherwise), refuses the rest.
 */
export function knownCurrency(code: string): boolean {
  if (!FORMAT.test(code)) return false;
  if (known === undefined) known = listCurrencies();
  return known === null || known.has(code);
}

/**
 * How many decimals the currency's minor unit has: 2 for EUR, 0 for JPY, 3 for BHD. Lenient: a
 * code Intl does not know gets its default (2), so a stored row still reads; writes check the
 * code first (`knownCurrency`).
 */
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
