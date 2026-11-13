// Credits are whole minor units of the deployment's currency: shown and typed in major units.
// The currency's exponent and its words come from the framework's money helpers, as for every
// other amount: nothing here rounds or assumes a currency.
import { type LedgerEntry, toMinor } from '@hykr/contracts';
import { type Lang, moneyText } from '@hykr/i18n';

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

/**
 * What a person typed ("12.5", "1,000") as whole minor units, or undefined when it is not a
 * positive amount of this currency (more decimals than the currency has are refused, not
 * rounded).
 */
export function parseCredits(typed: string, currency: string): number | undefined {
  try {
    const minor = toMinor(typed.replace(/[\s,]/g, ''), currency);
    return minor >= 1 ? minor : undefined;
  } catch {
    return undefined;
  }
}

/** A meter's quantity in its own words: voice seconds as minutes, the rest as counted. */
export function meterQuantity(meter: string, quantity: number): string {
  if (meter === 'voice_seconds') return `${Math.ceil(quantity / 60)} min`;
  return new Intl.NumberFormat('en').format(quantity);
}

/**
 * What a wallet entry was for, in the reader's words: a debit by its use (the meter as people
 * call it, and how much), never its stored note, which names the meter in the code; a grant or a
 * top-up by the words written with it.
 */
export function entryDetail(
  e: Partial<Pick<LedgerEntry, 'kind' | 'use'>> & Pick<LedgerEntry, 'note'>,
): string {
  if (e.use) return `${e.use.label}: ${meterQuantity(e.use.meter, e.use.quantity)}`;
  if (e.kind === 'debit') return '';
  return e.note ?? '';
}
