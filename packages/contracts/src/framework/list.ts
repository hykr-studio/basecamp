import { z } from 'zod';

/**
 * The list grammar: what callers may filter, sort and page on. One builder serves the
 * HTTP query string (?done=false&dueOn[lte]=2026-10-31&sort=-dueOn), the agent's JSON
 * ({ done: false, dueOn: { lte: '2026-10-31' } }) and repository calls inside commands.
 * Anything not declared is a validation error, never a silent full scan.
 */

export type FieldType = 'enum' | 'date' | 'text' | 'number' | 'boolean' | 'id';
export type FilterOp = 'eq' | 'ne' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains';

export const OPS: Record<FieldType, readonly FilterOp[]> = {
  enum: ['eq', 'ne', 'in'],
  id: ['eq', 'ne', 'in'],
  boolean: ['eq', 'ne'],
  text: ['eq', 'ne', 'in', 'contains'],
  date: ['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte'],
  number: ['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte'],
};

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

function valueSchema(type: FieldType, readField: z.ZodType | undefined, coerce: boolean) {
  switch (type) {
    case 'boolean':
      return coerce
        ? z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        : z.boolean();
    case 'number':
      return coerce ? z.coerce.number() : z.number();
    case 'date':
      return z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
    case 'enum': {
      const base = readField ? inner(readField) : undefined;
      return base instanceof z.ZodEnum ? base : z.string();
    }
    case 'id':
      return z.string().min(1);
    case 'text':
      return z.string().max(200);
  }
}

/** The raw object form, strict: unknown fields and unknown operators are rejected. */
export function listInputObject(spec: Spec, opts: { coerce?: boolean; maxLimit?: number } = {}) {
  const { list } = spec;
  const coerce = opts.coerce ?? false;
  const shape: Record<string, z.ZodType> = {};
  for (const [field, type] of Object.entries(list.filterable)) {
    const value = valueSchema(type, spec.schemas.read.shape[field], coerce);
    const ops: Record<string, z.ZodType> = {};
    for (const op of OPS[type]) {
      const many = z.array(value).min(1).max(100);
      ops[op] =
        op === 'in'
          ? (coerce
              ? z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), many)
              : many
            ).optional()
          : value.optional();
    }
    shape[field] = z.union([value, z.object(ops).strict()]).optional();
  }
  if (list.search?.length) shape.q = z.string().min(1).max(200).optional();
  const limit = z
    .number()
    .int()
    .min(1)
    .max(opts.maxLimit ?? list.pageSize.max);
  shape.sort = z.string().max(200).optional();
  shape.limit = (coerce ? z.coerce.number().pipe(limit) : limit).optional();
  shape.cursor = z.string().max(2000).optional();
  shape.count = (coerce ? valueSchema('boolean', undefined, true) : z.boolean()).optional();
  return z.object(shape).strict();
}

function normalize(spec: Spec, raw: Record<string, unknown>, ctx: z.RefinementCtx): ListQuery {
  const { list } = spec;
  const filters: ListFilter[] = [];
  for (const field of Object.keys(list.filterable)) {
    const v = raw[field];
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [op, value] of Object.entries(v)) {
        if (value !== undefined) filters.push({ field, op: op as FilterOp, value });
      }
    } else {
      filters.push({ field, op: 'eq', value: v });
    }
  }
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
function nestBrackets(value: unknown) {
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

/** The client's side: JSON form → query string with bracket operators. */
export function toQueryString(input: ListInput = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [op, v] of Object.entries(value)) {
        if (v !== undefined)
          params.append(`${key}[${op}]`, Array.isArray(v) ? v.join(',') : String(v));
      }
    } else {
      params.append(key, String(value));
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
