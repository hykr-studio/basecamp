// Credits are whole minor units of the deployment's currency: shown and typed in major units.
// The currency's exponent and its words come from @hykr/i18n, as for every other amount.
import { currencyExponent, type Lang, moneyText } from '@hykr/i18n';

/** How many minor units make one major unit of this currency (100 for most, 1 for some). */
export function minorPerMajor(currency: string): number {
  try {
    return 10 ** currencyExponent(currency);
  } catch {
    return 1;
  }
}

/** An amount of credits as money in the reader's language: 12345 EUR minor → "€123.45". */
export function formatCredits(
  minor: number,
  currency: string | null | undefined,
  lang: Lang = 'en',
): string {
  if (!currency) return String(minor);
  try {
    return moneyText({ minor, currency }, lang);
  } catch {
    return `${currency} ${minor}`;
  }
}

/** What a person typed ("12.5") as whole minor units, or undefined when it is not an amount. */
export function toMinor(typed: string, currency: string): number | undefined {
  const value = Number(typed.replace(/[\s,]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const minor = Math.round(value * minorPerMajor(currency));
  return minor >= 1 ? minor : undefined;
}

/** A meter's quantity in its own words: voice seconds as minutes, the rest as counted. */
export function meterQuantity(meter: string, quantity: number): string {
  if (meter === 'voice_seconds') return `${Math.ceil(quantity / 60)} min`;
  return new Intl.NumberFormat('en').format(quantity);
}
