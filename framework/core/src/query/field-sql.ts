import type { FieldType, FilterOp } from '@hykr/contracts';
import { createHookRegistry } from '@hykr/contracts';
import {
  type Column,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';

declare module '@hykr/contracts' {
  interface Contributions {
    listFieldSql: readonly ListFieldSql[];
  }
}

/** One filter as a field type's SQL sees it. Values arrive validated by the type's schema. */
export interface ListFieldFilter {
  table: Table;
  /** The filterable field's name. */
  field: string;
  /** Its column, when the field is one (a custom field kept in jsonb is not). */
  column: Column | undefined;
  op: FilterOp;
  value: unknown;
}

/**
 * The SQL half of a list field type (its grammar is `defineListFieldType` in @hykr/contracts).
 * A filterable field of a type without SQL fails the request rather than filter nothing.
 */
export interface ListFieldSql {
  /** The field type it serves. */
  name: FieldType;
  /** The condition for one filter. */
  where(filter: ListFieldFilter): SQL;
}

/** Each list field type's SQL, built-in and contributed (`contributes: { listFieldSql }`). */
export const listFieldSql = createHookRegistry<ListFieldSql>('list field SQL', (x) => x.name, {
  collects: 'listFieldSql',
});

/** Values arrive as JSON strings; timestamp columns compare against Dates. */
export function toColumnValue(column: Column, value: unknown): unknown {
  if (typeof value === 'string' && column.columnType === 'PgTimestamp') return new Date(value);
  if (typeof value === 'string' && column.columnType === 'PgDateString') return value.slice(0, 10);
  return value;
}

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The built-in types: one column, compared as its type. */
function columnWhere({ column, field, op, value }: ListFieldFilter): SQL {
  if (!column) throw new Error(`List config names "${field}", which is not a column`);
  const v = toColumnValue(column, value);
  switch (op) {
    case 'eq':
      return v === null ? sql`${column} is null` : eq(column, v);
    case 'ne':
      return ne(column, v);
    case 'in':
      return inArray(
        column,
        (value as unknown[]).map((x) => toColumnValue(column, x)),
      );
    case 'lt':
      return lt(column, v);
    case 'lte':
      return lte(column, v);
    case 'gt':
      return gt(column, v);
    case 'gte':
      return gte(column, v);
    case 'contains':
      return ilike(column, `%${escapeLike(String(v))}%`);
    default:
      throw new Error(`The operator "${op}" does not apply to field "${field}"`);
  }
}

for (const name of ['enum', 'id', 'boolean', 'text', 'date', 'number'] as const)
  listFieldSql.register({ name, where: columnWhere });

/** The SQL for one filter of a field of this type. */
export function filterSql(type: FieldType, filter: ListFieldFilter): SQL {
  const sqlOf = listFieldSql.get(type);
  if (!sqlOf) throw new Error(`No SQL for list field type "${type}" (listFieldSql)`);
  return sqlOf.where(filter);
}
