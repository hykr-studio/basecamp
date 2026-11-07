import { z } from 'zod';
import { createHookRegistry } from './registry.js';

/**
 * The list grammar: what callers may filter, sort and page on. One builder serves the
 * HTTP query string (?done=false&dueOn[lte]=2026-10-31&sort=-dueOn), the agent's JSON
 * ({ done: false, dueOn: { lte: '2026-10-31' } }) and repository calls inside commands.
 * Anything not declared is a validation error, never a silent full scan.
 */

/**
 * The field types a list can filter on. Open: a feature adds one by declaration merging and
 * defines it with `defineListFieldType` (its SQL is registered in @hykr/core, `listFieldSql`):
 *
 *   declare module '@hykr/contracts' {
 *     interface ListFieldTypes { geo: true }
 *     interface ListFilterOps { near: true }
 *   }
 */
export interface ListFieldTypes {
  enum: true;
  date: true;
  text: true;
  number: true;
  boolean: true;
  id: true;
}
export type FieldType = keyof ListFieldTypes;

/** The filter operators. Open, like ListFieldTypes. */
export interface ListFilterOps {
  eq: true;
  ne: true;
  in: true;
  lt: true;
  lte: true;
  gt: true;
  gte: true;
  contains: true;
}
export type FilterOp = keyof ListFilterOps;

/** A calendar period a date field is grouped by in a summary. */
export const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

/**
 * What a field of a type does in a summary (`GET /api/<plural>/summary`): group rows by its
 * value (`value`) or by a calendar period of it (`bucket`), and be measured (sum, avg, min,
 * max) as a number or as money. A type without it is filtered only.
 */
export interface FieldSummary {
  group?: 'value' | 'bucket';
  measure?: 'number' | 'money';
}

/** What a field type's value schema is built from. */
export interface FieldValueContext {
  /** The field in the entity's read schema (an enum takes its values from it). */
  readField: z.ZodType | undefined;
  /** From a query string: strings are coerced to the type. */
  coerce: boolean;
}

/**
 * One list field type: its operators and the schema of a value. Isomorphic: the server, the
 * agent's tools and the apps validate with it, so it registers when its module loads.
 */
export interface ListFieldType {
  name: FieldType;
  /** The operators it takes, in the order tools describe them. A bare value means `eq`. */
  ops: readonly FilterOp[];
  /** One value of the field. `in` takes a list of them. */
  value(ctx: FieldValueContext): z.ZodType;
  /** The value of an operator that is not one value or a list of them (near: { lat, lng, m }). */
  opValue?(op: FilterOp, ctx: FieldValueContext): z.ZodType | undefined;
  /** What its fields do in a summary. Absent: they are only filtered. */
  summary?: FieldSummary;
}

/** Every list field type, built-in and added. A name is defined once. */
export const listFieldTypes = createHookRegistry<ListFieldType>('list field type', (t) => t.name);

/** Define a list field type. It is usable in `filterable` from then on, in every process. */
export function defineListFieldType(type: ListFieldType): ListFieldType {
  listFieldTypes.register(type);
  return type;
}

/** The field type by name. An unknown name throws: a filter is never silently dropped. */
export function listFieldType(name: string): ListFieldType {
  const type = listFieldTypes.get(name);
  if (!type) throw new Error(`No list field type "${name}" is defined (defineListFieldType)`);
  return type;
}

/** The operators of a field type. */
export const opsOf = (type: FieldType): readonly FilterOp[] => listFieldType(type).ops;

export interface ListConfig {
  filterable: Record<string, FieldType>;
  sortable: string[];
  defaultSort: [string, 'asc' | 'desc'][];
  /** Columns matched case-insensitively by `q`. */
  search?: string[];
  pageSize: { default: number; max: number };
  /** Max rows per call for the agent's tool: every row costs tokens. Default 20. */
  toolPageSize?: number;
  /** One example per filterable field, shown in the tool description. */
  examples?: Record<string, string>;
}

export interface ListFilter {
  field: string;
  op: FilterOp;
  value: unknown;
}
export interface ListSort {
  field: string;
  dir: 'asc' | 'desc';
}
/** A list request after validation: what the repository executes. */
export interface ListQuery {
  filters: ListFilter[];
  q?: string;
  sort: ListSort[];
  limit: number;
  cursor?: string;
  count: boolean;
}

/** The JSON form callers send: field values or { op: value } objects, plus paging. */
export type ListInput = {
  [field: string]: unknown;
  q?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
  count?: boolean;
};

type Spec = { list: ListConfig; schemas: { read: z.ZodObject } };

function inner(schema: z.ZodType): z.ZodType {
  let cur = schema as z.ZodType & { _zod: { def: { innerType?: z.ZodType } } };
  while (cur._zod.def.innerType) cur = cur._zod.def.innerType as typeof cur;
  return cur;
}

const coerceBoolean = (coerce: boolean) =>
  coerce
    ? z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
    : z.boolean();

// The built-in types.
const EQUALITY = ['eq', 'ne', 'in'] as const;
const ORDERED = ['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte'] as const;
for (const type of [
  {
    name: 'enum',
    ops: EQUALITY,
    value: ({ readField }) => {
      const base = readField ? inner(readField) : undefined;
      return base instanceof z.ZodEnum ? base : z.string();
    },
    summary: { group: 'value' },
  },
  { name: 'id', ops: EQUALITY, value: () => z.string().min(1), summary: { group: 'value' } },
  {
    name: 'boolean',
    ops: ['eq', 'ne'],
    value: ({ coerce }) => coerceBoolean(coerce),
    summary: { group: 'value' },
  },
  {
    name: 'text',
    ops: [...EQUALITY, 'contains'],
    value: () => z.string().max(200),
    summary: { group: 'value' },
  },
  {
    name: 'date',
    ops: ORDERED,
    value: () => z.union([z.iso.datetime({ offset: true }), z.iso.date()]),
    summary: { group: 'bucket' },
  },
  {
    name: 'number',
    ops: ORDERED,
    value: ({ coerce }) => (coerce ? z.coerce.number() : z.number()),
    summary: { measure: 'number' },
  },
] satisfies ListFieldType[])
  defineListFieldType(type);

/**
 * The filters of a list config as object-schema fields: what lists and summaries both accept.
 * `coerce`: from a query string, strings are coerced to each field's type.
 */
export function filterShape(spec: Spec, coerce: boolean): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [field, typeName] of Object.entries(spec.list.filterable)) {
    const type = listFieldType(typeName);
    const ctx: FieldValueContext = { readField: spec.schemas.read.shape[field], coerce };
    const value = type.value(ctx);
    const ops: Record<string, z.ZodType> = {};
    for (const op of type.ops) {
      const own = type.opValue?.(op, ctx);
      if (own) {
        ops[op] = own.optional();
        continue;
      }
      const many = z.array(value).min(1).max(100);
      ops[op] =
        op === 'in'
          ? (coerce
              ? z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), many)
              : many
            ).optional()
          : value.optional();
    }
    const byOp = z.object(ops).strict();
    shape[field] = (type.ops.includes('eq') ? z.union([value, byOp]) : byOp).optional();
  }
  if (spec.list.search?.length) shape.q = z.string().min(1).max(200).optional();
  return shape;
}

/** The raw object form, strict: unknown fields and unknown operators are rejected. */
export function listInputObject(spec: Spec, opts: { coerce?: boolean; maxLimit?: number } = {}) {
  const { list } = spec;
  const coerce = opts.coerce ?? false;
  const shape = filterShape(spec, coerce);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(opts.maxLimit ?? list.pageSize.max);
  shape.sort = z.string().max(200).optional();
  shape.limit = (coerce ? z.coerce.number().pipe(limit) : limit).optional();
  shape.cursor = z.string().max(2000).optional();
  shape.count = coerceBoolean(coerce).optional();
  return z.object(shape).strict();
}

const isOpForm = (v: unknown, ops: readonly string[]): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => ops.includes(k));

/** The filters in a validated raw input (from `filterShape`), as the repository runs them. */
export function filtersIn(spec: Spec, raw: Record<string, unknown>): ListFilter[] {
  const filters: ListFilter[] = [];
  for (const [field, typeName] of Object.entries(spec.list.filterable)) {
    const v = raw[field];
    if (v === undefined) continue;
    const ops: readonly string[] = opsOf(typeName);
    // The operator form: an object whose keys are all this type's operators. Any other value
    // (an object-valued type's point, say) is a bare value, which means eq.
    if (isOpForm(v, ops)) {
      for (const [op, value] of Object.entries(v)) {
        if (value !== undefined) filters.push({ field, op: op as FilterOp, value });
      }
    } else {
      filters.push({ field, op: 'eq', value: v });
    }
  }
  return filters;
}

function normalize(spec: Spec, raw: Record<string, unknown>, ctx: z.RefinementCtx): ListQuery {
  const { list } = spec;
  const filters = filtersIn(spec, raw);
  const sort: ListSort[] = [];
  const sortText = raw.sort as string | undefined;
  if (sortText) {
    for (const part of sortText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const dir = part.startsWith('-') ? 'desc' : 'asc';
      const field = part.replace(/^[-+]/, '');
      if (!list.sortable.includes(field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sort'],
          message: `Cannot sort by "${field}". Sortable: ${list.sortable.join(', ')}`,
        });
        return z.NEVER;
      }
      sort.push({ field, dir });
    }
  }
  return {
    filters,
    q: raw.q as string | undefined,
    sort: sort.length ? sort : list.defaultSort.map(([field, dir]) => ({ field, dir })),
    limit: (raw.limit as number | undefined) ?? list.pageSize.default,
    cursor: raw.cursor as string | undefined,
    count: (raw.count as boolean | undefined) ?? false,
  };
}

/** JSON form → ListQuery. For tool input and repository calls inside commands. */
export function listInputSchema(spec: Spec, opts: { maxLimit?: number } = {}) {
  return listInputObject(spec, { coerce: false, maxLimit: opts.maxLimit }).transform((raw, ctx) =>
    normalize(spec, raw, ctx),
  );
}

/** `a[b]=c` keys from a flat query string become `{ a: { b: c } }`. */
export function nestBrackets(value: unknown) {
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const m = /^([A-Za-z0-9_]+)\[([A-Za-z]+)\]$/.exec(key);
    if (m) {
      if (typeof out[m[1]] !== 'object' || out[m[1]] === null) out[m[1]] = {};
      (out[m[1]] as Record<string, unknown>)[m[2]] = v;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** HTTP query string → ListQuery: strings are coerced to each field's type. */
export function listQuerySchema(spec: Spec) {
  return z.preprocess(
    nestBrackets,
    listInputObject(spec, { coerce: true }).transform((raw, ctx) => normalize(spec, raw, ctx)),
  );
}

/** One operator's value in a query string: a list as a comma list, an object as JSON. */
const queryValue = (v: unknown): string =>
  Array.isArray(v)
    ? v.join(',')
    : v !== null && typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);

/**
 * The client's side: JSON form → query string with bracket operators. An operator whose value
 * is an object (a geo field's `near: { lat, lng, radiusM }`) goes as JSON, which its type reads.
 */
export function toQueryString(input: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [op, v] of Object.entries(value)) {
        if (v !== undefined) params.append(`${key}[${op}]`, queryValue(v));
      }
    } else {
      params.append(key, queryValue(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Every list response: a page of read rows and the cursor for the next one. */
export function pageSchema<R extends z.ZodType>(read: R) {
  return z.object({
    items: z.array(read),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });
}
export type Page<T> = { items: T[]; nextCursor: string | null; total?: number };
