// A time as a keyset cursor keeps it. Postgres stores microseconds and a JavaScript Date keeps
// milliseconds, so a cursor cut on the Date took its own row again (ascending: `t > T_ms`) or
// skipped the rows of that millisecond (descending: `t < T_ms`). A cursor keeps the stored value
// as text instead, read in the same statement as its row, and compares it in SQL against the
// expression the query orders by (docs/decisions/V12.md; the SLA cursor did so first, S3).
import { type Column, type SQL, sql } from 'drizzle-orm';

/** What `exactTime` writes: UTC to the microsecond, `YYYY-MM-DDTHH:MI:SS.ffffff`. */
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
/** What a cursor made before V12 kept: `toISOString`, to the millisecond. */
const MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US'`);

/** A column with a time zone (every framework table's), else a plain timestamp. */
const zoned = (column: Column) =>
  (column as Column & { withTimezone?: boolean }).withTimezone !== false;

/**
 * A time column's value as Postgres stores it, as text to the microsecond. `expr` is what the
 * query orders by when it is not the bare column (a nullable column's `coalesce`).
 */
export function exactTime(column: Column, expr: SQL | Column = column): SQL<string> {
  return zoned(column)
    ? sql<string>`to_char(${expr} at time zone 'UTC', ${FORMAT})`
    : sql<string>`to_char(${expr}, ${FORMAT})`;
}

/**
 * A time a cursor kept: `exact` when `exactTime` wrote it; else the millisecond a cursor made
 * before V12 kept, which a client may still hold.
 */
export type TimeKey = { text: string; exact: boolean };

/**
 * A cursor's time back, or undefined: what `exactTime` writes or an older cursor's
 * `toISOString`, naming a real instant Postgres can store (no 31 February, no year 0000).
 */
export function readTimeKey(value: unknown): TimeKey | undefined {
  if (typeof value !== 'string') return undefined;
  const exact = EXACT.test(value);
  if (!exact && !MILLIS.test(value)) return undefined;
  const ms = Date.parse(`${value.slice(0, 23)}Z`);
  if (Number.isNaN(ms) || value.startsWith('0000')) return undefined;
  if (new Date(ms).toISOString().slice(0, 23) !== value.slice(0, 23)) return undefined;
  return { text: value, exact };
}

/** The key as a time in SQL, of the column's own type. */
function timeOf(column: Column, key: TimeKey): SQL {
  const text = key.exact ? `${key.text}Z` : key.text;
  return zoned(column) ? sql`${text}::timestamptz` : sql`${text}::timestamp`;
}

/**
 * `expr` past the key in this direction: later ascending, earlier descending. An older cursor's
 * millisecond holds its row's real time somewhere inside it, so descending takes that whole
 * millisecond: such a cursor's next page may repeat rows of it, and skips none.
 */
export function timeAfter(
  column: Column,
  expr: SQL | Column,
  key: TimeKey,
  dir: 'asc' | 'desc',
): SQL {
  const at = timeOf(column, key);
  if (dir === 'asc') return sql`${expr} > ${at}`;
  return key.exact ? sql`${expr} < ${at}` : sql`${expr} < ${at} + interval '1 millisecond'`;
}

/** `expr` at the key: the very time, or anywhere in an older cursor's millisecond. */
export function timeSame(column: Column, expr: SQL | Column, key: TimeKey): SQL {
  const at = timeOf(column, key);
  return key.exact
    ? sql`${expr} = ${at}`
    : sql`(${expr} >= ${at} and ${expr} < ${at} + interval '1 millisecond')`;
}

/** `expr` at or past the key: the bound an index serves (`>=` before a tie-break on id). */
export function timeFrom(column: Column, expr: SQL | Column, key: TimeKey): SQL {
  return sql`${expr} >= ${timeOf(column, key)}`;
}
