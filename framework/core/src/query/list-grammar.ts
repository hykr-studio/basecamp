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
};

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
      };
    }
    const column = col(s.field);
    return {
      field: s.field,
      dir: s.dir,
      column,
      expr: sortExpr(column, s.dir),
      at: (value) => toColumnValue(column, value),
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
    case 'PgBigInt53':
      return far === 'max' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    default:
      return far === 'max' ? 1e15 : -1e15;
  }
}
