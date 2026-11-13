import type { ListConfig, ListQuery } from '@hykr/contracts';
import { BadRequestException } from '@nestjs/common';
import {
  and,
  type Column,
  getTableColumns,
  gt,
  ilike,
  or,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import { escapeLike, filterSql, listFieldSql, toColumnValue } from './field-sql.js';

/**
 * Turns a validated ListQuery into SQL pieces. The owner clause is added by the
 * repository before these; filters only narrow within it.
 */

type SortKey = {
  field: string;
  dir: 'asc' | 'desc';
  expr: SQL | Column;
  column: Column | undefined;
  /** The sort expression's value for a value a cursor kept. */
  at: (value: unknown) => unknown;
  /** What a cursor keeps for a row. */
  keep: (row: Record<string, unknown>) => unknown;
  /** Could `keep` have made this value? A cursor is the client's to send back, and to tamper with. */
  check: (value: unknown) => boolean;
};

const badCursor = () =>
  new BadRequestException({ error: 'bad_cursor', message: 'This cursor is not valid' });

/** `YYYY-MM-DD`, a day the calendar has. */
function isDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** An instant as `toISOString` writes it. */
const isIsoInstant = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** A timestamp as Postgres writes it as text ('2026-11-12 16:55:48.123456+00'). */
function isPgTimestamp(value: string): boolean {
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/.exec(
      value,
    );
  return !!m && isDay(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** What a cursor may hold for a column of this type: exactly what `keep` and `encodeCursor` emit. */
function columnCheck(column: Column): (value: unknown) => boolean {
  const str = (ok: (s: string) => boolean) => (v: unknown) => typeof v === 'string' && ok(v);
  switch (column.columnType) {
    case 'PgDateString':
      return str(isDay);
    case 'PgDate':
      return str((s) => isDay(s) || isIsoInstant(s));
    case 'PgTimestamp':
      return str(isIsoInstant);
    case 'PgTimestampString':
      return str(isPgTimestamp);
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgSerial':
    case 'PgSmallSerial':
    case 'PgBigInt53':
    case 'PgBigSerial53':
      return (v) => Number.isSafeInteger(v);
    case 'PgDoublePrecision':
    case 'PgReal':
    case 'PgNumericNumber':
      return (v) => typeof v === 'number' && Number.isFinite(v);
    case 'PgNumeric':
    case 'PgNumericBigInt':
      return (v) =>
        (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && NUMERIC.test(v));
    case 'PgBoolean':
      return (v) => typeof v === 'boolean';
    case 'PgUUID':
      return str((s) => UUID.test(s));
    case 'PgEnumColumn':
    case 'PgEnumObjectColumn':
      return str((s) => (column.enumValues ?? []).includes(s));
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
      return str(() => true);
    default:
      // A type this list does not know: a scalar, and Postgres has the last word (listQuery).
      return (v) => ['string', 'number', 'boolean'].includes(typeof v);
  }
}

/** The whole numbers each integer column holds. */
const INTEGER_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  PgSmallInt: [-32_768, 32_767],
  PgSmallSerial: [-32_768, 32_767],
  PgInteger: [-2_147_483_648, 2_147_483_647],
  PgSerial: [-2_147_483_648, 2_147_483_647],
  PgBigInt53: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  PgBigSerial53: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

/**
 * What a column holds, when this filter value is not it; else null. Only what Postgres would
 * refuse outright: an integer column's whole numbers and range, a numeric column's precision, a
 * uuid's form, an enum's values. Other values (text, dates the schema bounded) are its to compare.
 */
function unfit(column: Column, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const range = INTEGER_RANGE[column.columnType];
  if (range)
    return typeof v === 'number' && Number.isInteger(v) && v >= range[0] && v <= range[1]
      ? null
      : `whole numbers from ${range[0]} to ${range[1]}`;
  if (column.columnType.startsWith('PgNumeric')) {
    const { precision, scale = 0 } = column as Column & { precision?: number; scale?: number };
    const n = Number(v);
    if (precision === undefined || !Number.isFinite(n)) return null;
    const below = 10 ** (precision - scale);
    return Math.abs(n) < below ? null : `numbers below ${below} (either way)`;
  }
  if (column.columnType === 'PgUUID')
    return typeof v === 'string' && UUID.test(v) ? null : 'ids (uuids)';
  if (column.columnType === 'PgEnumColumn' || column.columnType === 'PgEnumObjectColumn') {
    const values = column.enumValues ?? [];
    return typeof v === 'string' && values.includes(v) ? null : `one of ${values.join(', ')}`;
  }
  return null;
}

/**
 * A filter value the field type's schema takes and its column cannot hold (`rank=1e12` on an
 * integer column, an id that is no uuid) is 400 `invalid`, before any query: Postgres's refusal
 * was a 500, or `bad_cursor` with a cursor, which blamed the cursor for the filter (V10).
 */
function refuseUnfit(column: Column, f: ListQuery['filters'][number]): void {
  if (f.op === 'contains') return;
  for (const v of Array.isArray(f.value) ? f.value : [f.value]) {
    const holds = unfit(column, v);
    if (holds)
      throw new BadRequestException({
        error: 'invalid',
        field: f.field,
        message: `"${f.field}" holds ${holds}`,
      });
  }
}

/** Nullable sort columns sort as if nulls were a far-off value: always last. */
function sortExpr(column: Column, dir: 'asc' | 'desc'): SQL | Column {
  if (column.notNull) return column;
  const far = dir === 'asc' ? 'max' : 'min';
  switch (column.columnType) {
    case 'PgDateString':
    case 'PgDate':
      return sql`coalesce(${column}, ${far === 'max' ? '9999-12-31' : '0001-01-01'}::date)`;
    case 'PgTimestamp':
    case 'PgTimestampString':
      return sql`coalesce(${column}, ${far === 'max' ? '9999-12-31T00:00:00Z' : '0001-01-01T00:00:00Z'}::timestamptz)`;
    case 'PgInteger':
    case 'PgNumeric':
    case 'PgDoublePrecision':
    case 'PgReal':
      return sql`coalesce(${column}, ${far === 'max' ? 1e15 : -1e15})`;
    // Money in minor units: past any amount a JavaScript number holds exactly.
    case 'PgBigInt53':
      return sql`coalesce(${column}, ${farValue(column, far)}::bigint)`;
    default:
      throw new Error(
        `Sorting on nullable ${column.columnType} column "${column.name}" is not supported: cursors would skip its nulls`,
      );
  }
}

export type Cursor = { s: string; v: unknown[]; id: string };

const signature = (sort: ListQuery['sort']) =>
  sort.map((s) => `${s.dir === 'desc' ? '-' : ''}${s.field}`).join(',');

export function encodeCursor(sort: ListQuery['sort'], values: unknown[], id: string): string {
  const v = values.map((x) => (x instanceof Date ? x.toISOString() : x));
  return Buffer.from(JSON.stringify({ s: signature(sort), v, id } satisfies Cursor)).toString(
    'base64url',
  );
}

/**
 * The cursor a list handed out, back from the client: its shape is checked here, each value
 * against its sort key when the clause is built (`after`). Anything else is 400 `bad_cursor`.
 */
export function decodeCursor(cursor: string, sort: ListQuery['sort']): Cursor {
  let parsed: Cursor;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.s !== 'string' ||
    !Array.isArray(parsed.v) ||
    typeof parsed.id !== 'string' ||
    parsed.id.length > 200
  )
    throw badCursor();
  if (parsed.s !== signature(sort)) {
    throw new BadRequestException({
      error: 'cursor_sort_mismatch',
      message: `This cursor was made for sort "${parsed.s}". Drop the cursor to start over with sort "${signature(sort)}".`,
    });
  }
  if (parsed.v.length !== sort.length) throw badCursor();
  return parsed;
}

/** Postgres's data exceptions (SQLSTATE class 22): a value out of range, an unknown enum value. */
const isDataException = (err: unknown): boolean => {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as never)
    if (typeof e.code === 'string' && e.code.startsWith('22')) return true;
  return false;
};

/**
 * Runs a list query. With a cursor, a value Postgres cannot take is the cursor's fault: 400
 * `bad_cursor`, the backstop to the checks `after` makes. Without one it stays the bug it is.
 */
export async function listQuery<T>(cursor: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (cursor && isDataException(err)) throw badCursor();
    throw err;
  }
}

export function buildListSql(table: Table, list: ListConfig, q: ListQuery) {
  const columns = getTableColumns(table) as Record<string, Column>;
  const col = (field: string) => {
    const c = columns[field];
    if (!c) throw new Error(`List config names "${field}", which is not a column`);
    return c;
  };

  const where: SQL[] = [];
  for (const f of q.filters) {
    // Each field type builds its own condition (listFieldSql): built-in or contributed.
    const type = list.filterable[f.field];
    if (!type) throw new Error(`"${f.field}" is not filterable`);
    const column = columns[f.field];
    if (column) refuseUnfit(column, f);
    where.push(
      filterSql(type, {
        table,
        field: f.field,
        column: columns[f.field],
        op: f.op,
        value: f.value,
      }),
    );
  }
  if (q.q && list.search?.length) {
    const term = `%${escapeLike(q.q)}%`;
    const matches = list.search.map((field) => ilike(col(field), term));
    where.push(matches.length === 1 ? matches[0] : (or(...matches) as SQL));
  }

  // id is always the final key, so the order is total and cursors never skip or repeat.
  const id = col('id');
  const idCheck = columnCheck(id);
  const keys: SortKey[] = q.sort.map((s) => {
    // A field type with its own order (a point: by distance to its near filter's point).
    const type = list.filterable[s.field];
    const own = type ? listFieldSql.get(type)?.order : undefined;
    if (own) {
      const order = own({
        table,
        field: s.field,
        column: columns[s.field],
        dir: s.dir,
        filters: q.filters.filter((f) => f.field === s.field),
      });
      return {
        field: s.field,
        dir: s.dir,
        column: columns[s.field],
        expr: order.expr,
        at: order.at,
        keep: (row) => row[s.field] ?? null,
        check: order.check ?? (() => true),
      };
    }
    const column = col(s.field);
    return {
      field: s.field,
      dir: s.dir,
      column,
      expr: sortExpr(column, s.dir),
      at: (value) => toColumnValue(column, value),
      check: columnCheck(column),
      keep: (row) => {
        const value = row[s.field];
        if (value !== null && value !== undefined) return value;
        return column.notNull ? value : farValue(column, s.dir === 'asc' ? 'max' : 'min');
      },
    };
  });
  const orderBy: SQL[] = [
    ...keys.map((k) => (k.dir === 'asc' ? sql`${k.expr} asc` : sql`${k.expr} desc`)),
    sql`${id} asc`,
  ];

  /** Keyset: rows strictly after the cursor row in this order. */
  function after(cursor: Cursor): SQL {
    if (cursor.v.length !== keys.length || !keys.every((k, i) => k.check(cursor.v[i])))
      throw badCursor();
    if (!idCheck(cursor.id)) throw badCursor();
    const cmp = (k: SortKey, value: unknown) =>
      k.dir === 'asc' ? sql`${k.expr} > ${k.at(value)}` : sql`${k.expr} < ${k.at(value)}`;
    const same = (k: SortKey, value: unknown) => sql`${k.expr} = ${k.at(value)}`;
    const branches: SQL[] = keys.map(
      (k, i) =>
        and(...keys.slice(0, i).map((p, j) => same(p, cursor.v[j])), cmp(k, cursor.v[i])) as SQL,
    );
    branches.push(and(...keys.map((p, j) => same(p, cursor.v[j])), gt(id, cursor.id)) as SQL);
    return or(...branches) as SQL;
  }

  /** The values a cursor stores for a row: what each sort expression evaluates to. */
  function cursorValues(row: Record<string, unknown>): unknown[] {
    return keys.map((k) => k.keep(row));
  }

  return { where, orderBy, after, cursorValues, limit: q.limit };
}

function farValue(column: Column, far: 'max' | 'min') {
  switch (column.columnType) {
    case 'PgDateString':
    case 'PgDate':
      return far === 'max' ? '9999-12-31' : '0001-01-01';
    case 'PgTimestamp':
      return new Date(far === 'max' ? '9999-12-31T00:00:00Z' : '0001-01-01T00:00:00Z');
    case 'PgTimestampString':
      return far === 'max' ? '9999-12-31 00:00:00+00' : '0001-01-01 00:00:00+00';
    case 'PgBigInt53':
      return far === 'max' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    default:
      return far === 'max' ? 1e15 : -1e15;
  }
}
