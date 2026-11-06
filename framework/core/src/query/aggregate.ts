import {
  fieldPolicyOf,
  hiddenFields,
  type ListFilter,
  type ListQuery,
  type Money,
  measureKey,
  type Principal,
  type Summary,
  type SummaryBucket,
  type SummaryGroup,
  type SummaryMeasure,
  type SummaryQuery,
  type SummaryValue,
  TenantSettings,
} from '@hykr/contracts';
import { schema } from '@hykr/db';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { type Column, eq, getTableColumns, type SQL, sql } from 'drizzle-orm';
import { type AnyEntityDef, tenantOf } from '../entity/define-entity.js';
import type { Conn } from '../tokens.js';

/**
 * Summaries (B14): counts and totals of an entity's records in SQL, grouped by up to two fields,
 * over exactly the rows its list reaches for the reader, and never over a field the reader
 * cannot see. `GET /api/<plural>/summary` and the `summarize-<plural>` tool run it.
 */

/**
 * A connection that records the WHERE of the first query built on it instead of running it, and
 * answers every query with no rows.
 */
function recorder(): { conn: Conn; wheres: SQL[] } {
  const wheres: SQL[] = [];
  const chain: object = new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'then') return (resolve: (rows: unknown[]) => void) => resolve([]);
      if (key === 'where')
        return (where: SQL) => {
          wheres.push(where);
          return chain;
        };
      return () => chain;
    },
  });
  return { conn: chain as Conn, wheres };
}

/**
 * The WHERE of the entity's list for this principal and these filters: its business, the
 * principal's grants, every entity plugin's scope, then the filters (and `q`). Read from the
 * repository's own list query, run against a recording connection, so a summary reaches exactly
 * the rows a list would, whatever narrows the list later. Fails closed if the list's query is not
 * the one recorded.
 */
export async function listWhere(
  def: AnyEntityDef,
  p: Principal,
  q: { filters: ListFilter[]; q?: string },
): Promise<SQL> {
  const rec = recorder();
  const query: ListQuery = { filters: q.filters, q: q.q, sort: [], limit: 1, count: false };
  await def.repo.list(rec.conn, p, query);
  const [where] = rec.wheres;
  if (rec.wheres.length !== 1 || !where)
    throw new Error(`${def.name}: could not read its list's scope for a summary`);
  return where;
}

/** The fields a summary names: what the reader must be able to see. */
function namedFields(def: AnyEntityDef, q: SummaryQuery, currencyKey: string | undefined) {
  return new Set([
    ...q.filters.map((f) => f.field),
    ...q.groupBy.map((g) => g.field),
    ...q.measures.map((m) => m.field),
    ...(q.q ? (def.spec.list.search ?? []) : []),
    ...(currencyKey ? [currencyKey] : []),
  ]);
}

/**
 * The fields this principal sees on the entity's records: one record of its scope, without the
 * filters (so a refusal never says whether a filter on a hidden field matched), read through
 * `toRead` (plugins' projections and the read projectors). Null: it reaches no record.
 */
async function visibleFields(
  conn: Conn,
  def: AnyEntityDef,
  p: Principal,
): Promise<Set<string> | null> {
  const page = await def.repo.list(conn, p, { filters: [], sort: [], limit: 1, count: false });
  const row = page.items[0];
  if (!row) return null;
  return new Set(Object.keys(def.toRead(row, p) as object));
}

/** The business's time zone (its settings), which dates are bucketed in. */
async function tenantTimeZone(conn: Conn, tenantId: string): Promise<string> {
  const [row] = await conn
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  const stored = (row?.settings ?? {}) as Record<string, unknown>;
  const zone = TenantSettings.shape.timeZone.safeParse(stored.timeZone);
  const timeZone = zone.success ? zone.data : 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

const FORMATS = {
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  quarter: 'YYYY-"Q"Q',
  year: 'YYYY',
} as const;

/** A group's expression: the column, or its calendar period in the business's time zone. */
function groupExpr(column: Column, g: SummaryGroup, timeZone: string): SQL {
  if (!g.bucket) return sql`${column}`;
  const local =
    column.columnType === 'PgTimestamp' || column.columnType === 'PgTimestampString'
      ? (column as unknown as { withTimezone?: boolean }).withTimezone
        ? sql`(${column} at time zone ${timeZone})`
        : sql`${column}`
      : sql`${column}::timestamp`;
  // Units and formats are the grammar's own words, never the caller's text.
  return sql`to_char(date_trunc(${sql.raw(`'${g.bucket}'`)}, ${local}), ${sql.raw(`'${FORMATS[g.bucket]}'`)})`;
}

/**
 * A measure over the inner query's value column. Money stays exact as numeric (which the driver
 * returns as text) and an average of it is rounded half up to whole minor units.
 */
function measureSql(m: SummaryMeasure, value: SQL): SQL {
  if (m.money)
    return m.fn === 'avg'
      ? sql`round(avg(${value}))::numeric`
      : sql`${sql.raw(m.fn)}(${value})::numeric`;
  return sql`${sql.raw(m.fn)}(${value})::float8`;
}

const ident = (name: string) => sql.identifier(name);

/** A money amount from Postgres's exact numeric (as text). */
function minorOf(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error(`A summed amount is past exact numbers: ${text}`);
  return n;
}

/**
 * Counts and totals of an entity's records for a principal. Groups are cut at `q.limit` (`more`
 * says so); totals cover every row. Money is summed per currency: its currency joins every key,
 * and totals has one bucket per currency.
 */
export async function summarize(
  conn: Conn,
  def: AnyEntityDef,
  p: Principal,
  q: SummaryQuery,
): Promise<Summary> {
  const { spec } = def;
  const columns = getTableColumns(def.table) as Record<string, Column>;
  const trait = spec.traits?.money;
  const currencyKey = q.measures.some((m) => m.money) ? (trait?.currency ?? 'currency') : undefined;
  const empty = (): Summary => ({ groups: [], totals: [emptyBucket(q)], more: false });

  // The reader must see every field the summary names. First the declared field policy (the
  // same for every record), then what plugins refuse of a list asking for these fields, then
  // the reader's projection of a record in reach (read projectors may hide more). A reader who
  // reaches no record gets zeros, which reveal nothing.
  const named = [...namedFields(def, q, currencyKey)];
  const refuse = (field: string) => {
    const label = spec.fieldLabels?.[field]?.en ?? field;
    return new ForbiddenException({
      error: 'forbidden',
      rule: 'field_hidden',
      reason: `You can't summarize ${spec.plural} by ${label}`,
    });
  };
  const policyHidden = new Set(hiddenFields(fieldPolicyOf(spec), p));
  const declared = named.find((f) => policyHidden.has(f));
  if (declared) throw refuse(declared);
  const asList: ListQuery = {
    filters: q.filters,
    q: q.q,
    sort: named.map((field) => ({ field, dir: 'asc' })),
    limit: 1,
    count: false,
  };
  for (const x of def.plugins()) x.query?.(asList, p, { spec, table: def.table });
  const visible = await visibleFields(conn, def, p);
  if (!visible) return empty();
  const projected = named.find((f) => !visible.has(f));
  if (projected) throw refuse(projected);

  const column = (field: string) => {
    const c = columns[field];
    if (!c)
      throw new BadRequestException({
        error: 'not_summarizable',
        message: `${field} is not a column of ${spec.plural}, so it cannot be summarized`,
      });
    return c;
  };
  const where = await listWhere(def, p, q);
  const timeZone = q.groupBy.some((g) => g.bucket)
    ? await tenantTimeZone(conn, tenantOf(p))
    : 'UTC';

  // The inner query: each record's group values, currency and measured values, in reach.
  const valueFields = [...new Set(q.measures.map((m) => m.field))];
  const inner: SQL[] = [sql`1 as ${ident('one')}`];
  q.groupBy.forEach((g, i) => {
    inner.push(sql`${groupExpr(column(g.field), g, timeZone)} as ${ident(`g${i}`)}`);
  });
  if (currencyKey) inner.push(sql`${column(currencyKey)} as ${ident('c')}`);
  valueFields.forEach((field, i) => {
    inner.push(sql`${column(field)} as ${ident(`v${i}`)}`);
  });
  const from = sql`(select ${sql.join(inner, sql`, `)} from ${def.table} where ${where}) as ${ident('t')}`;

  const measures = q.measures.map((m, j) => ({
    m,
    alias: `m${j}`,
    expr: measureSql(m, sql`${ident(`v${valueFields.indexOf(m.field)}`)}`),
  }));
  const aggregates = [
    sql`count(*)::int as ${ident('n')}`,
    ...measures.map((x) => sql`${x.expr} as ${ident(x.alias)}`),
  ];

  const bucketOf = (row: Record<string, unknown>, keyed: boolean): SummaryBucket => {
    const key: SummaryBucket['key'] = {};
    if (keyed)
      q.groupBy.forEach((g, i) => {
        key[g.field] = (row[`g${i}`] as string | boolean | null) ?? null;
      });
    if (currencyKey) key[currencyKey] = (row.c as string | null) ?? null;
    const bucket: SummaryBucket = { key, count: Number(row.n) };
    for (const { m, alias } of measures) {
      const raw = row[alias];
      let value: SummaryValue = null;
      if (raw !== null && raw !== undefined)
        value = m.money
          ? ({ minor: minorOf(String(raw)), currency: String(row.c) } satisfies Money)
          : Number(raw);
      bucket[m.fn] = { ...bucket[m.fn], [m.field]: value };
    }
    return bucket;
  };

  // Totals: every row, per currency when money is measured.
  const totalRows = (
    await conn.execute(
      sql`select ${sql.join([...(currencyKey ? [sql`${ident('c')}`] : []), ...aggregates], sql`, `)} from ${from}${currencyKey ? sql` group by ${ident('c')} order by ${ident('c')}` : sql``}`,
    )
  ).rows as Record<string, unknown>[];
  const totals = totalRows.map((row) => bucketOf(row, false));

  // Groups, ordered and cut at the limit.
  let groups: SummaryBucket[] = [];
  let more = false;
  if (q.groupBy.length) {
    const keys = [...q.groupBy.map((_, i) => ident(`g${i}`)), ...(currencyKey ? [ident('c')] : [])];
    const dir = sql.raw(q.sort.dir === 'desc' ? 'desc' : 'asc');
    const byKey = keys.map((k) => sql`${k} ${dir} nulls last`);
    const keysAsc = keys.map((k) => sql`${k} asc nulls last`);
    const order =
      q.sort.by === 'key'
        ? byKey
        : q.sort.by === 'count'
          ? [sql`${ident('n')} ${dir}`, ...keysAsc]
          : [
              sql`${ident(measures.find((x) => measureKey(x.m) === q.sort.by)?.alias ?? 'n')} ${dir} nulls last`,
              ...keysAsc,
            ];
    const rows = (
      await conn.execute(
        sql`select ${sql.join([...keys, ...aggregates], sql`, `)} from ${from} group by ${sql.join(keys, sql`, `)} order by ${sql.join(order, sql`, `)} limit ${q.limit + 1}`,
      )
    ).rows as Record<string, unknown>[];
    more = rows.length > q.limit;
    groups = rows.slice(0, q.limit).map((row) => bucketOf(row, true));
  }
  return { groups, totals: totals.length ? totals : [emptyBucket(q)], more };
}

/** No rows: a count of zero, and every measure null. */
function emptyBucket(q: SummaryQuery): SummaryBucket {
  const bucket: SummaryBucket = { key: {}, count: 0 };
  for (const m of q.measures) bucket[m.fn] = { ...bucket[m.fn], [m.field]: null };
  return bucket;
}
