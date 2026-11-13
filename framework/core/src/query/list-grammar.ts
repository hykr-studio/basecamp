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
import { exactTime, readTimeKey, type TimeKey, timeAfter, timeSame } from './exact-time.js';
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
  /**
   * What the cursor keeps instead of `keep`'s value, selected with the row: a time as Postgres
   * stores it, which the row's Date has lost (V12). `past` and `same` then compare it.
   */
  exact?: SQL;
  /** The sort expression past this kept value in the key's direction. */
  past?: (value: unknown) => SQL;
  /** The sort expression at this kept value. */
  same?: (value: unknown) => SQL;
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
      return (v) => readTimeKey(v) !== undefined;
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
    const expr = sortExpr(column, s.dir);
    return {
      field: s.field,
      dir: s.dir,
      column,
      expr,
      at: (value) => toColumnValue(column, value),
      check: columnCheck(column),
      keep: (row) => {
        const value = row[s.field];
        if (value !== null && value !== undefined) return value;
        return column.notNull ? value : farValue(column, s.dir === 'asc' ? 'max' : 'min');
      },
      // A time: the cursor keeps it as stored, to the microsecond (V12). Its `coalesce` too, so
      // a row with none keeps the far-off time in the same form.
      ...(column.columnType === 'PgTimestamp'
        ? {
            exact: exactTime(column, expr),
            past: (value: unknown) => timeAfter(column, expr, value as TimeKey, s.dir),
            same: (value: unknown) => timeSame(column, expr, value as TimeKey),
          }
        : {}),
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
    // A time's kept text, read once: `check` has passed it.
    const kept = (k: SortKey, value: unknown) => (k.exact ? readTimeKey(value) : value);
    const cmp = (k: SortKey, value: unknown) =>
      k.past
        ? k.past(kept(k, value))
        : k.dir === 'asc'
          ? sql`${k.expr} > ${k.at(value)}`
          : sql`${k.expr} < ${k.at(value)}`;
    const same = (k: SortKey, value: unknown) =>
      k.same ? k.same(kept(k, value)) : sql`${k.expr} = ${k.at(value)}`;
    const branches: SQL[] = keys.map(
      (k, i) =>
        and(...keys.slice(0, i).map((p, j) => same(p, cursor.v[j])), cmp(k, cursor.v[i])) as SQL,
    );
    branches.push(and(...keys.map((p, j) => same(p, cursor.v[j])), gt(id, cursor.id)) as SQL);
    return or(...branches) as SQL;
  }

  /**
   * What a list selects: its row, and beside it each time key as Postgres stores it. A cursor
   * made from the row alone would keep the millisecond its Date holds (V12).
   */
  const fields: ListFields = { row: table };
  keys.forEach((k, i) => {
    if (k.exact) fields[`key${i}`] = k.exact;
  });

  /** The cursor after this selected row: what each sort expression evaluates to, and its id. */
  function cursorAfter(selected: ListSelected): string {
    const values = keys.map((k, i) => (k.exact ? selected[`key${i}`] : k.keep(selected.row)));
    return encodeCursor(q.sort, values, String(selected.row.id));
  }

  return { where, orderBy, after, fields, cursorAfter, limit: q.limit };
}

/** What `buildListSql`'s `fields` select: the table's row, and the keys its cursor keeps. */
export type ListFields = { row: Table } & Record<string, Table | SQL>;
/** A row as `fields` selected it. */
export type ListSelected = { row: Record<string, unknown> } & Record<string, unknown>;

function farValue(column: Column, far: 'max' | 'min') {
  switch (column.columnType) {
    case 'PgDateString':
    case 'PgDate':
      return far === 'max' ? '9999-12-31' : '0001-01-01';
    case 'PgTimestampString':
      return far === 'max' ? '9999-12-31 00:00:00+00' : '0001-01-01 00:00:00+00';
    case 'PgBigInt53':
      return far === 'max' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    default:
      return far === 'max' ? 1e15 : -1e15;
  }
}
