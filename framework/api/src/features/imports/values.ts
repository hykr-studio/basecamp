// From a file's row to a write's input: which fields an entity takes, and CSV text turned into
// the value each field's schema accepts. Nothing here touches the database or Nest.
import type { EntitySpec, ImportOptions } from '@hykr/contracts';
import type { z } from 'zod';

type Shape = Record<string, z.ZodType>;

/** The fields of an object schema (through a transform's input, when it has one). */
export function shapeOf(schema: z.ZodType): Shape {
  let s = schema as unknown as {
    shape?: Shape;
    _zod?: { def?: { type?: string; in?: z.ZodType } };
  };
  for (let i = 0; i < 5 && !s.shape && s._zod?.def?.type === 'pipe' && s._zod.def.in; i++)
    s = s._zod.def.in as unknown as typeof s;
  return s.shape ?? {};
}

/** The fields an import may fill: the create schema's, and the update schema's. */
export interface EntityFields {
  create: Shape;
  update: Shape;
  /** Every field either schema takes. */
  all: Set<string>;
}

export function fieldsOf(spec: EntitySpec): EntityFields {
  const create = shapeOf(spec.schemas.create);
  const update = shapeOf(spec.schemas.update);
  return { create, update, all: new Set([...Object.keys(create), ...Object.keys(update)]) };
}

/** How each column of the file is read: the field it fills, or none. */
export interface ColumnPlan {
  /** Column → field. Columns not here are not read. */
  fieldOf: Map<string, string>;
  /** Columns that are neither the key, a field, an `_` column nor left out. */
  unknown: string[];
}

/**
 * Columns to fields: a column's `columns` mapping (null leaves it out), else its own name.
 * The key column and columns starting with `_` (an error report's own) are not fields.
 */
export function planColumns(
  columns: readonly string[],
  fields: EntityFields,
  o: Pick<ImportOptions, 'key' | 'columns'>,
): ColumnPlan {
  const fieldOf = new Map<string, string>();
  const unknown: string[] = [];
  for (const column of columns) {
    const mapped = o.columns && Object.hasOwn(o.columns, column) ? o.columns[column] : undefined;
    if (mapped === null) continue;
    if (column === o.key && mapped === undefined) continue;
    if (column.startsWith('_') && mapped === undefined) continue;
    const field = mapped ?? column;
    if (fields.all.has(field)) fieldOf.set(column, field);
    else unknown.push(column);
  }
  return { fieldOf, unknown };
}

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUE = new Set(['true', 'yes', 'y', '1']);
const FALSE = new Set(['false', 'no', 'n', '0']);

/**
 * One CSV cell as its field takes it. Empty: left out (`omit`), or null where the field takes
 * null (`null`). Otherwise the text as it is when the schema accepts it; else the number,
 * true/false or JSON value it spells, when the schema accepts that; else the text, for the
 * schema to refuse with its own message.
 */
export function cellValue(
  schema: z.ZodType | undefined,
  text: string,
  empty: ImportOptions['empty'],
): unknown {
  if (text === '') return empty === 'null' && schema && accepts(schema, null) ? null : undefined;
  if (!schema || accepts(schema, text)) return text;
  const trimmed = text.trim();
  const candidates: unknown[] = [];
  if (trimmed !== text) candidates.push(trimmed);
  if (NUMBER.test(trimmed)) candidates.push(Number(trimmed));
  const word = trimmed.toLowerCase();
  if (TRUE.has(word)) candidates.push(true);
  if (FALSE.has(word)) candidates.push(false);
  if (/^[[{"]/.test(trimmed) || word === 'null')
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Not JSON: the schema says why the text does not fit.
    }
  return candidates.find((c) => accepts(schema, c)) ?? text;
}

/** Two values the same, as a record shows them (dates as ISO strings, key order ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([k, x]) => [k, norm(x)]),
      );
    return v ?? null;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Only these keys of a row's values, without undefined. */
export function pick(values: Record<string, unknown>, keys: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values))
    if (v !== undefined && Object.hasOwn(keys, k)) out[k] = v;
  return out;
}
