import { z } from 'zod';
import {
  DATE_BUCKETS,
  type DateBucket,
  filterShape,
  filtersIn,
  type ListConfig,
  type ListFilter,
  listFieldType,
  nestBrackets,
} from './list.js';
import type { Money } from './money.js';
import type { EntityTraits } from './traits.js';

/**
 * Summaries (B14): counts and totals of an entity's records, grouped or not, under the same
 * scope and filters as its list (`GET /api/<plural>/summary`, the `summarize-<plural>` tool,
 * `kpi.row`'s `of`). What a field can do comes from its list field type (`summary` on
 * `defineListFieldType`): only filterable fields are summarized.
 *
 *   HTTP:  GET /api/orders/summary?status=open&groupBy=createdAt:month&sum=total&sort=-key&limit=4
 *   JSON:  { status: 'open', groupBy: ['createdAt:month'], sum: ['total'], sort: '-key', limit: 4 }
 */

/** The measures a summary can take of a number or money field. The count is always there. */
export const SUMMARY_FNS = ['sum', 'avg', 'min', 'max'] as const;
export type SummaryFn = (typeof SUMMARY_FNS)[number];

/** At most this many group fields, measures and groups. */
export const SUMMARY_LIMITS = { groupBy: 2, measures: 6, groups: { default: 50, max: 200 } };

type Spec = { list: ListConfig; schemas: { read: z.ZodObject }; traits?: EntityTraits };

/** Which fields of an entity a summary can group by, and which it can measure. */
export function summarizable(spec: Spec): {
  group: { field: string; by: 'value' | 'bucket' }[];
  measure: { field: string; as: 'number' | 'money' }[];
} {
  const group: { field: string; by: 'value' | 'bucket' }[] = [];
  const measure: { field: string; as: 'number' | 'money' }[] = [];
  for (const [field, type] of Object.entries(spec.list.filterable)) {
    const s = listFieldType(type).summary;
    if (s?.group) group.push({ field, by: s.group });
    if (s?.measure) measure.push({ field, as: s.measure });
  }
  return { group, measure };
}

/** One group of a summary: a field's value, or a date field's calendar period. */
export interface SummaryGroup {
  field: string;
  bucket?: DateBucket;
}

/** One measure: `sum` of `total`. `money`: the field holds money of the record's currency. */
export interface SummaryMeasure {
  fn: SummaryFn;
  field: string;
  money: boolean;
}

/** What groups are ordered by: their count, their key, or a measure (`sum:total`). */
export interface SummarySort {
  by: string;
  dir: 'asc' | 'desc';
}

/** A summary request after validation: what the server runs. */
export interface SummaryQuery {
  filters: ListFilter[];
  q?: string;
  groupBy: SummaryGroup[];
  measures: SummaryMeasure[];
  sort: SummarySort;
  limit: number;
}

/** The JSON form callers send: the list's filters, then what to group by and measure. */
export type SummaryInput = {
  [field: string]: unknown;
  q?: string;
  groupBy?: string | string[];
  sum?: string | string[];
  avg?: string | string[];
  min?: string | string[];
  max?: string | string[];
  sort?: string;
  limit?: number;
};

/** A measure's value: a number, money (per currency), or null when no record has one. */
export type SummaryValue = number | Money | null;

/** One bucket: its key (the group's values; empty for the totals), its count and measures. */
export interface SummaryBucket {
  key: Record<string, string | boolean | null>;
  count: number;
  sum?: Record<string, SummaryValue>;
  avg?: Record<string, SummaryValue>;
  min?: Record<string, SummaryValue>;
  max?: Record<string, SummaryValue>;
}

/**
 * A summary: its groups (none without `groupBy`), its totals (one bucket, or one per currency
 * when it measures money) and whether groups were left out past `limit`.
 */
export interface Summary {
  groups: SummaryBucket[];
  totals: SummaryBucket[];
  more: boolean;
}

const Value = z.union([
  z.number(),
  z.object({ minor: z.number().int(), currency: z.string() }),
  z.null(),
]);
const Measures = z.record(z.string(), Value).optional();
export const SummaryBucketSchema = z.object({
  key: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
  count: z.number().int(),
  sum: Measures,
  avg: Measures,
  min: Measures,
  max: Measures,
});
/** A summary's shape, for views whose props carry one (`source: { by: 'summary' }`). */
export const SummarySchema = z.object({
  groups: z.array(SummaryBucketSchema),
  totals: z.array(SummaryBucketSchema),
  more: z.boolean(),
});

/** The key of a measure in `sort` and in `kpi.row` labels: `sum:total`. */
export const measureKey = (m: { fn: SummaryFn; field: string }) => `${m.fn}:${m.field}`;

/** The tokens `groupBy` takes: `status`, or `createdAt:month` for a date. */
function groupTokens(spec: Spec): string[] {
  return summarizable(spec).group.flatMap(({ field, by }) =>
    by === 'bucket' ? DATE_BUCKETS.map((b) => `${field}:${b}`) : [field],
  );
}

/** A list of names, from JSON (a string or an array) or a query string (a comma list). */
const names = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : v,
    z.array(item).min(1).max(max),
  );

/** The raw object form, strict: unknown fields, groups and measures are rejected. */
export function summaryInputObject(spec: Spec, opts: { coerce?: boolean } = {}) {
  const coerce = opts.coerce ?? false;
  for (const word of ['groupBy', ...SUMMARY_FNS])
    if (word in spec.list.filterable)
      throw new Error(`A filterable field cannot be called "${word}": summaries use the word`);
  const shape = filterShape(spec, coerce);
  const tokens = groupTokens(spec);
  const measurable = summarizable(spec).measure.map((m) => m.field);
  if (tokens.length)
    shape.groupBy = names(z.enum(tokens as [string, ...string[]]), SUMMARY_LIMITS.groupBy)
      .optional()
      .describe(
        `Group by up to ${SUMMARY_LIMITS.groupBy} of: ${tokens.join(', ')} (a date by day, week, month, quarter or year)`,
      );
  if (measurable.length)
    for (const fn of SUMMARY_FNS)
      shape[fn] = names(z.enum(measurable as [string, ...string[]]), SUMMARY_LIMITS.measures)
        .optional()
        .describe(`The ${fn} of these fields`);
  shape.sort = z
    .string()
    .max(100)
    .optional()
    .describe(
      'Order of the groups: count, key or <fn>:<field> (sum:total); "-" first for descending',
    );
  const limit = z.number().int().min(1).max(SUMMARY_LIMITS.groups.max);
  shape.limit = (coerce ? z.coerce.number().pipe(limit) : limit).optional();
  return z.object(shape).strict();
}

function normalize(spec: Spec, raw: Record<string, unknown>, ctx: z.RefinementCtx): SummaryQuery {
  const kinds = new Map(summarizable(spec).measure.map((m) => [m.field, m.as]));
  const money = new Set(spec.traits?.money?.fields ?? []);
  const groupBy: SummaryGroup[] = [];
  for (const token of new Set((raw.groupBy as string[] | undefined) ?? [])) {
    const [field, bucket] = token.split(':');
    if (groupBy.some((g) => g.field === field)) {
      ctx.addIssue({ code: 'custom', path: ['groupBy'], message: `Group by ${field} once` });
      return z.NEVER;
    }
    groupBy.push(bucket ? { field, bucket: bucket as DateBucket } : { field });
  }
  const measures: SummaryMeasure[] = [];
  for (const fn of SUMMARY_FNS)
    for (const field of new Set((raw[fn] as string[] | undefined) ?? []))
      measures.push({ fn, field, money: kinds.get(field) === 'money' && money.has(field) });
  if (measures.length > SUMMARY_LIMITS.measures) {
    ctx.addIssue({
      code: 'custom',
      path: ['sum'],
      message: `At most ${SUMMARY_LIMITS.measures} measures in one summary`,
    });
    return z.NEVER;
  }
  const sortText = (raw.sort as string | undefined)?.trim();
  const sort: SummarySort = { by: groupBy.length ? 'key' : 'count', dir: 'asc' };
  if (sortText) {
    const by = sortText.replace(/^[-+]/, '');
    const known = ['count', 'key', ...measures.map(measureKey)];
    if (!known.includes(by)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sort'],
        message: `Cannot order groups by "${by}". Use one of: ${known.join(', ')}`,
      });
      return z.NEVER;
    }
    sort.by = by;
    sort.dir = sortText.startsWith('-') ? 'desc' : 'asc';
  }
  return {
    filters: filtersIn(spec, raw),
    q: raw.q as string | undefined,
    groupBy,
    measures,
    sort,
    limit: (raw.limit as number | undefined) ?? SUMMARY_LIMITS.groups.default,
  };
}

/** JSON form → SummaryQuery: for tools, clients and calls inside the server. */
export function summaryInputSchema(spec: Spec) {
  return summaryInputObject(spec).transform((raw, ctx) => normalize(spec, raw, ctx));
}

/** HTTP query string → SummaryQuery: strings are coerced to each field's type. */
export function summaryQuerySchema(spec: Spec) {
  return z.preprocess(
    nestBrackets,
    summaryInputObject(spec, { coerce: true }).transform((raw, ctx) => normalize(spec, raw, ctx)),
  );
}
