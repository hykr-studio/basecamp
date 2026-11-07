import { currencyExponent } from '@hykr/i18n';
import { z } from 'zod';
import { defineListFieldType } from './list.js';

/**
 * Money, as the framework moves it: a whole number of the currency's minor units and the
 * currency itself (ISO 4217). The framework assumes no currency: a business's default lives in
 * its settings (`money.currency`) and a deployment's default in its environment. Formatting
 * goes through Intl (`moneyText` in @hykr/i18n), which also knows each currency's minor-unit
 * exponent. Arithmetic here is exact: integers, with BigInt where a product could pass 2^53.
 */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'An ISO 4217 currency code, upper case: "EUR"');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** A whole number of minor units, within what a JavaScript number holds exactly. */
export const MinorUnits = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export type MinorUnits = z.infer<typeof MinorUnits>;

export const Money = z.object({
  /** Whole minor units of the currency (an integer). */
  minor: MinorUnits,
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

/** An amount as people and models write it: "1234.50", "-3", "0.125". */
export const DecimalAmount = z
  .string()
  .regex(/^-?\d{1,16}(\.\d{1,6})?$/, 'A decimal amount: "1234.50"');

/**
 * Money as a write takes it: minor units (with the currency, or in the record's), or a decimal
 * string in the record's currency. A bare number is refused: it could be either unit.
 */
export const MoneyInput = z.union([
  z.object({ minor: MinorUnits, currency: CurrencyCode.optional() }),
  DecimalAmount,
]);
export type MoneyInput = z.infer<typeof MoneyInput>;

/** Rounding of a fraction of a minor unit. `half-up` rounds halves away from zero. */
export const Rounding = z.enum(['half-up', 'half-even', 'down', 'up', 'floor', 'ceil']);
export type Rounding = z.infer<typeof Rounding>;

/** Two amounts in different currencies met where one currency was needed. */
export class CurrencyMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly got: string,
  ) {
    super(`Expected an amount in ${expected}, got one in ${got}`);
    this.name = 'CurrencyMismatch';
  }
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** A BigInt result as a number of minor units, or a RangeError past the safe range. */
function safe(n: bigint): number {
  if (n > MAX || n < -MAX) throw new RangeError(`${n} minor units is out of range`);
  return Number(n);
}

function int(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer, got ${n}`);
  return BigInt(n);
}

/** n / d (d > 0), rounded as asked. */
function divRound(n: bigint, d: bigint, rounding: Rounding): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const sign = n < 0n ? -1n : 1n;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (rounding) {
    case 'down':
      return q;
    case 'up':
      return q + sign;
    case 'floor':
      return n < 0n ? q - 1n : q;
    case 'ceil':
      return n > 0n ? q + 1n : q;
    case 'half-up':
      return twice >= d ? q + sign : q;
    case 'half-even':
      if (twice > d) return q + sign;
      if (twice < d) return q;
      return q % 2n === 0n ? q : q + sign;
  }
}

/**
 * minor × num / den, rounded once, exactly (a rate of 18.5% is 185 / 1000). The product may
 * pass 2^53; the result may not.
 */
export function mulDiv(
  minor: number,
  num: number,
  den: number,
  rounding: Rounding = 'half-up',
): number {
  let d = int(den, 'The denominator');
  if (d === 0n) throw new RangeError('Division by zero');
  let n = int(minor, 'The amount') * int(num, 'The numerator');
  if (d < 0n) {
    d = -d;
    n = -n;
  }
  return safe(divRound(n, d, rounding));
}

/** An amount, checked: whole minor units and a currency code. */
export function money(minor: number, currency: string): Money {
  return Money.parse({ minor, currency });
}

export const zeroMoney = (currency: string): Money => money(0, currency);

function same(a: Money, b: Money) {
  if (a.currency !== b.currency) throw new CurrencyMismatch(a.currency, b.currency);
}

export function addMoney(a: Money, b: Money): Money {
  same(a, b);
  return { minor: safe(BigInt(a.minor) + BigInt(b.minor)), currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  same(a, b);
  return { minor: safe(BigInt(a.minor) - BigInt(b.minor)), currency: a.currency };
}

/** The sum, in this currency (zero for none). Another currency throws. */
export function sumMoney(items: readonly Money[], currency: string): Money {
  let total = 0n;
  for (const m of items) {
    if (m.currency !== currency) throw new CurrencyMismatch(currency, m.currency);
    total += BigInt(m.minor);
  }
  return { minor: safe(total), currency };
}

/** m × num / den, rounded once: a quantity, a rate, a discount. */
export function scaleMoney(m: Money, num: number, den: number, rounding?: Rounding): Money {
  return { minor: mulDiv(m.minor, num, den, rounding), currency: m.currency };
}

/**
 * Split a whole into parts by weight, so the parts add up to it exactly: each part is rounded
 * down, then the units left over go to the largest remainders (the first of a tie).
 */
export function allocateMinor(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) throw new RangeError('Nothing to allocate to');
  const w = weights.map((x) => {
    const b = int(x, 'A weight');
    if (b < 0n) throw new RangeError('Weights must not be negative');
    return b;
  });
  const sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new RangeError('The weights add up to zero');
  const t = int(total, 'The total');
  const abs = t < 0n ? -t : t;
  const parts = w.map((x) => (abs * x) / sum);
  const rest = w.map((x, i) => ({ i, r: (abs * x) % sum }));
  let left = abs - parts.reduce((a, b) => a + b, 0n);
  rest.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of rest) {
    if (left === 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts.map((x) => safe(t < 0n ? -x : x));
}

/**
 * A decimal string as minor units of the currency ("1234.5" in a two-decimal currency is
 * 123450). More decimals than the currency has throw, unless they are zeros.
 */
export function toMinor(decimal: string, currency: string): number {
  const text = DecimalAmount.parse(decimal.trim());
  const exp = currencyExponent(CurrencyCode.parse(currency));
  const negative = text.startsWith('-');
  const [whole, frac = ''] = (negative ? text.slice(1) : text).split('.');
  const digits = frac.replace(/0+$/, '');
  if (digits.length > exp)
    throw new RangeError(`${currency} has ${exp} decimal${exp === 1 ? '' : 's'}: "${decimal}"`);
  const n = BigInt(`${whole}${digits.padEnd(exp, '0')}`);
  return safe(negative ? -n : n);
}

/** Minor units as a plain decimal string in the currency's exponent: 123450 → "1234.50". */
export function fromMinor(minor: number, currency: string): string {
  const exp = currencyExponent(CurrencyCode.parse(currency));
  const n = int(minor, 'The amount');
  const abs = (n < 0n ? -n : n).toString().padStart(exp + 1, '0');
  const sign = n < 0n ? '-' : '';
  if (exp === 0) return `${sign}${abs}`;
  return `${sign}${abs.slice(0, -exp)}.${abs.slice(-exp)}`;
}

/**
 * A write's amount in the record's currency. Minor units in another currency throw
 * (`CurrencyMismatch`); a decimal string is read with the currency's exponent.
 */
export function resolveMoneyInput(input: MoneyInput, currency: string): Money {
  const parsed = MoneyInput.parse(input);
  if (typeof parsed === 'string') return { minor: toMinor(parsed, currency), currency };
  if (parsed.currency !== undefined && parsed.currency !== currency)
    throw new CurrencyMismatch(currency, parsed.currency);
  return money(parsed.minor, currency);
}

/** Is this value a Money object (read side)? */
export const isMoney = (value: unknown): value is Money => Money.safeParse(value).success;

/**
 * The money an entity holds (its `money` trait): which fields are minor-unit columns, and
 * which column holds the record's currency (default 'currency'). The `money` plugin turns the
 * stored integers into `Money` on read and `MoneyInput` into integers on write.
 */
export interface MoneyTrait {
  fields: readonly string[];
  /** The record's currency column. Default 'currency'. */
  currency?: string;
}

declare module './traits.js' {
  interface EntityTraits {
    money?: MoneyTrait;
  }
}

declare module './list.js' {
  interface ListFieldTypes {
    money: true;
  }
}

/**
 * A money field in a list filter: whole minor units in the record's currency
 * (`total[gte]=50000`). A decimal is refused, so "500.00" never reads as 500 minor units.
 */
defineListFieldType({
  name: 'money',
  ops: ['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte'],
  value: ({ coerce }) => (coerce ? z.coerce.number().pipe(MinorUnits) : MinorUnits),
  // Summed per currency: a summary never adds amounts in two currencies.
  summary: { measure: 'money' },
});
