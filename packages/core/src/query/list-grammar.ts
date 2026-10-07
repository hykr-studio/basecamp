import type { ListConfig, ListQuery } from '@app/contracts';
import { BadRequestException } from '@nestjs/common';
import {
  and,
  type Column,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';

/**
 * Turns a validated ListQuery into SQL pieces. The owner clause is added by the
 * repository before these; filters only narrow within it.
 */

type SortKey = { field: string; dir: 'asc' | 'desc'; expr: SQL | Column; column: Column };

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
    default:
      throw new Error(
        `Sorting on nullable ${column.columnType} column "${column.name}" is not supported: cursors would skip its nulls`,
      );
  }
}

/** Values arrive as JSON strings; timestamp columns compare against Dates. */
function toColumnValue(column: Column, value: unknown): unknown {
  if (typeof value === 'string' && column.columnType === 'PgTimestamp') return new Date(value);
  if (typeof value === 'string' && column.columnType === 'PgDateString') return value.slice(0, 10);
  return value;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export type Cursor = { s: string; v: unknown[]; id: string };

const signature = (sort: ListQuery['sort']) =>
  sort.map((s) => `${s.dir === 'desc' ? '-' : ''}${s.field}`).join(',');

export function encodeCursor(sort: ListQuery['sort'], values: unknown[], id: string): string {
  const v = values.map((x) => (x instanceof Date ? x.toISOString() : x));
  return Buffer.from(JSON.stringify({ s: signature(sort), v, id } satisfies Cursor)).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string, sort: ListQuery['sort']): Cursor {
  let parsed: Cursor;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException({ error: 'bad_cursor', message: 'This cursor is not valid' });
  }
  if (parsed.s !== signature(sort)) {
    throw new BadRequestException({
      error: 'cursor_sort_mismatch',
      message: `This cursor was made for sort "${parsed.s}". Drop the cursor to start over with sort "${signature(sort)}".`,
    });
  }
  return parsed;
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
    const c = col(f.field);
    const v = toColumnValue(c, f.value);
    switch (f.op) {
      case 'eq':
        where.push(v === null ? sql`${c} is null` : eq(c, v));
        break;
      case 'ne':
        where.push(ne(c, v));
        break;
      case 'in':
        where.push(
          inArray(
            c,
            (f.value as unknown[]).map((x) => toColumnValue(c, x)),
          ),
        );
        break;
      case 'lt':
        where.push(lt(c, v));
        break;
      case 'lte':
        where.push(lte(c, v));
        break;
      case 'gt':
        where.push(gt(c, v));
        break;
      case 'gte':
        where.push(gte(c, v));
        break;
      case 'contains':
        where.push(ilike(c, `%${escapeLike(String(v))}%`));
        break;
    }
  }
  if (q.q && list.search?.length) {
    const term = `%${escapeLike(q.q)}%`;
    const matches = list.search.map((field) => ilike(col(field), term));
    where.push(matches.length === 1 ? matches[0] : (or(...matches) as SQL));
  }

  // id is always the final key, so the order is total and cursors never skip or repeat.
  const id = col('id');
  const keys: SortKey[] = q.sort.map((s) => ({
    field: s.field,
    dir: s.dir,
    column: col(s.field),
    expr: sortExpr(col(s.field), s.dir),
  }));
  const orderBy: SQL[] = [
    ...keys.map((k) => (k.dir === 'asc' ? sql`${k.expr} asc` : sql`${k.expr} desc`)),
    sql`${id} asc`,
  ];

  /** Keyset: rows strictly after the cursor row in this order. */
  function after(cursor: Cursor): SQL {
    const cmp = (k: SortKey, value: unknown) =>
      k.dir === 'asc'
        ? sql`${k.expr} > ${toColumnValue(k.column, value)}`
        : sql`${k.expr} < ${toColumnValue(k.column, value)}`;
    const same = (k: SortKey, value: unknown) => sql`${k.expr} = ${toColumnValue(k.column, value)}`;
    const branches: SQL[] = keys.map(
      (k, i) =>
        and(...keys.slice(0, i).map((p, j) => same(p, cursor.v[j])), cmp(k, cursor.v[i])) as SQL,
    );
    branches.push(and(...keys.map((p, j) => same(p, cursor.v[j])), gt(id, cursor.id)) as SQL);
    return or(...branches) as SQL;
  }

  /** The values a cursor stores for a row: what each sort expression evaluates to. */
  function cursorValues(row: Record<string, unknown>): unknown[] {
    return keys.map((k) => {
      const value = row[k.field];
      if (value !== null && value !== undefined) return value;
      return k.column.notNull
        ? value
        : k.dir === 'asc'
          ? farValue(k.column, 'max')
          : farValue(k.column, 'min');
    });
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
    default:
      return far === 'max' ? 1e15 : -1e15;
  }
}
