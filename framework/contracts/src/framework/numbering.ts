import { z } from 'zod';

/**
 * Number series: gapless document numbers per business ("ORD/2026-27/0042"). The application
 * declares each series' format and when it starts again; the framework allocates the numbers
 * (`nextNumber` in @hykr/core) in the write's transaction and formats them.
 *
 * Tokens: {seq} or {seq:N} (zero-padded to N digits), exactly once; {yyyy}, {yy} and {mm} (the
 * calendar date in the business's time zone); {fy} ("2026" for a calendar financial year,
 * "2026-27" otherwise), {fyStart} and {fyEnd} (the financial year's first and last calendar
 * years), with ":yy" for two digits. Anything else in braces is refused.
 */
export const NumberReset = z.enum(['none', 'yearly', 'fiscal']);
export type NumberReset = z.infer<typeof NumberReset>;

export interface NumberSeriesDef {
  /** Unique in the application, lower case, dotted: 'orders.order'. */
  readonly name: string;
  readonly format: string;
  /** When the count starts again at 1: never, each calendar year, each financial year. */
  readonly reset: NumberReset;
}

/** What a number's date depends on: the business's time zone and financial-year start. */
export interface PeriodSettings {
  timeZone: string;
  /** 1-12; 1 is the calendar year. */
  fyStartMonth: number;
}

const TOKEN = /\{([A-Za-z]+)(?::([A-Za-z0-9]+))?\}/g;
const CALENDAR = new Set(['yyyy', 'yy']);
const FISCAL = new Set(['fy', 'fyStart', 'fyEnd']);
const NAME = /^[a-z][a-z0-9_.-]{0,59}$/;

type Token = { name: string; arg?: string };

function tokensOf(format: string): Token[] {
  const tokens: Token[] = [];
  const rest = format.replace(TOKEN, (_m, name: string, arg?: string) => {
    tokens.push({ name, arg });
    return '';
  });
  if (/[{}]/.test(rest)) throw new Error(`Number format "${format}": a brace outside a token`);
  return tokens;
}

function checkToken(format: string, { name, arg }: Token) {
  const bad = () =>
    new Error(`Number format "${format}": unknown token {${name}${arg ? `:${arg}` : ''}}`);
  if (name === 'seq') {
    if (arg !== undefined && !/^(?:[1-9]|1[0-2])$/.test(arg)) throw bad();
    return;
  }
  if (name === 'yyyy' || name === 'yy' || name === 'mm' || name === 'fy') {
    if (arg !== undefined) throw bad();
    return;
  }
  if (name === 'fyStart' || name === 'fyEnd') {
    if (arg !== undefined && arg !== 'yy') throw bad();
    return;
  }
  throw bad();
}

/**
 * A series, checked: a name, a format with {seq} once and only known tokens, and a reset the
 * format can show (a yearly series needs a calendar year in its numbers, a fiscal one a
 * financial year), so a number is never repeated.
 */
export function defineNumberSeries(def: NumberSeriesDef): NumberSeriesDef {
  if (!NAME.test(def.name))
    throw new Error(`Number series "${def.name}": lower case letters, digits, "." "_" "-"`);
  NumberReset.parse(def.reset);
  const tokens = tokensOf(def.format);
  for (const t of tokens) checkToken(def.format, t);
  if (tokens.filter((t) => t.name === 'seq').length !== 1)
    throw new Error(`Number format "${def.format}": needs {seq} exactly once`);
  if (def.reset === 'yearly' && !tokens.some((t) => CALENDAR.has(t.name)))
    throw new Error(`Number series "${def.name}" starts again each year: put {yyyy} or {yy} in it`);
  if (def.reset === 'fiscal' && !tokens.some((t) => FISCAL.has(t.name)))
    throw new Error(
      `Number series "${def.name}" starts again each financial year: put {fy}, {fyStart} or {fyEnd} in it`,
    );
  return Object.freeze({ ...def });
}

/** The calendar year and month at this instant in this time zone. */
export function localYearMonth(at: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part('year'), month: part('month') };
}

/** The financial year an instant falls in: its first and last calendar years. */
export function fiscalYear(at: Date, s: PeriodSettings): { start: number; end: number } {
  const { year, month } = localYearMonth(at, s.timeZone);
  const start = month >= s.fyStartMonth ? year : year - 1;
  return { start, end: s.fyStartMonth === 1 ? start : start + 1 };
}

/** The counter a number at this instant comes from: '-', 'Y2026' or 'FY2026'. */
export function numberPeriod(def: NumberSeriesDef, at: Date, s: PeriodSettings): string {
  if (def.reset === 'yearly') return `Y${localYearMonth(at, s.timeZone).year}`;
  if (def.reset === 'fiscal') return `FY${fiscalYear(at, s).start}`;
  return '-';
}

const two = (n: number) => String(n % 100).padStart(2, '0');

/** The number as people read it: the format with its tokens filled in. */
export function formatNumber(
  def: NumberSeriesDef,
  seq: number,
  at: Date,
  s: PeriodSettings,
): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`Bad sequence number ${seq}`);
  const { year, month } = localYearMonth(at, s.timeZone);
  const fy = fiscalYear(at, s);
  return def.format.replace(TOKEN, (_m, name: string, arg?: string) => {
    switch (name) {
      case 'seq':
        return String(seq).padStart(arg ? Number(arg) : 1, '0');
      case 'yyyy':
        return String(year);
      case 'yy':
        return two(year);
      case 'mm':
        return String(month).padStart(2, '0');
      case 'fy':
        return s.fyStartMonth === 1 ? String(fy.start) : `${fy.start}-${two(fy.end)}`;
      case 'fyStart':
        return arg === 'yy' ? two(fy.start) : String(fy.start);
      case 'fyEnd':
        return arg === 'yy' ? two(fy.end) : String(fy.end);
      default:
        throw new Error(`Number format "${def.format}": unknown token {${name}}`);
    }
  });
}
