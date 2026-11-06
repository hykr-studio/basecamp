// Revisions (B4): v1, v2, v3 of one record, each a record of its own in one series. Revising
// copies a record and every tree of children under it as the next revision, in the write's
// transaction; the application then freezes the old one (a transition to a frozen state).
// docs/decisions/B6B4.md.
import { randomUUID } from 'node:crypto';
import {
  fileFieldsOf,
  type Principal,
  revisionFields,
  statesOf,
  versionedOf,
  versionField,
} from '@hykr/contracts';
import {
  and,
  type Column,
  eq,
  getTableColumns,
  max,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import { type ChildLink, childLinksOf } from '../entity/children.js';
import type { AnyEntityDef, RuleContext } from '../entity/define-entity.js';
import { assertWritable } from '../states/transition.js';
import type { Tx } from '../tokens.js';
import type { Touched } from '../write/pipeline.js';

type Values = Record<string, unknown>;

/** Rows per multi-row INSERT. */
const CHUNK = 500;

/** What a revision write made: the new revision, its children by entity, one touched row each. */
export interface Revision {
  row: Values;
  children: Record<string, Values[]>;
  touched: Touched[];
}

const keyOf = (columns: Record<string, Column>, col: Column | undefined) =>
  col ? Object.entries(columns).find(([, c]) => c === col)?.[0] : undefined;

/** A file field stays with the record it is on: a copy starts without it. */
function withoutFiles(spec: AnyEntityDef['spec'], columns: Record<string, Column>, values: Values) {
  for (const [field] of fileFieldsOf(spec)) {
    const c = columns[field];
    if (!c) continue;
    values[field] = c.notNull ? sql`'{}'::text[]` : null;
  }
}

/** Columns a copy takes from the database's defaults, not from the row it copies. */
const STAMPS = ['createdAt', 'updatedAt'];

async function insertChunks(tx: Tx, table: Table, rows: Values[]): Promise<Values[]> {
  const out: Values[] = [];
  for (let i = 0; i < rows.length; i += CHUNK)
    out.push(
      ...((await tx
        .insert(table)
        .values(rows.slice(i, i + CHUNK) as never)
        .returning()) as Values[]),
    );
  return out;
}

/** Depth of each row in its tree (0 at the top), so a node is inserted after the one above it. */
function byDepth(rows: Values[], nestKey: string | undefined): Values[] {
  if (!nestKey) return rows;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const depth = (r: Values) => {
    let d = 0;
    for (let at = r[nestKey]; at && d <= rows.length; at = byId.get(String(at))?.[nestKey]) d++;
    return d;
  };
  return [...rows].sort((a, b) => depth(a) - depth(b));
}

/**
 * Copy the children (and theirs, to any depth) of `fromId` under the new parent `to`: new ids,
 * the parent's owner and customer, nest pointers remapped. Raw inserts, a few hundred per
 * statement; each copy is audited as created.
 */
async function copyChildren(
  tx: Tx,
  p: Principal,
  link: ChildLink,
  fromId: string,
  to: Values,
  out: Revision,
): Promise<void> {
  const columns = getTableColumns(link.table) as Record<string, Column>;
  const fkKey = keyOf(columns, link.fk) as string;
  const nestKey = keyOf(columns, link.nest);
  const ownerKey = keyOf(columns, link.owner) as string;
  const customerKey = keyOf(columns, link.customer);
  const parentCols = getTableColumns(link.parent.table) as Record<string, Column>;
  const parentOwnerKey = keyOf(parentCols, link.parentOwner) as string;
  const parentCustomerKey = keyOf(parentCols, link.parentCustomer);
  const old = (await tx
    .select()
    .from(link.table)
    .where(and(eq(link.fk, fromId), eq(link.tenant, to.tenantId as string)) as SQL)) as Values[];
  if (!old.length) return;
  const ids = new Map(old.map((r) => [String(r.id), randomUUID()]));
  const copies = byDepth(old, nestKey).map((r) => {
    const values: Values = { ...r };
    for (const s of STAMPS) delete values[s];
    withoutFiles(link.child, columns, values);
    values.id = ids.get(String(r.id));
    values[fkKey] = to.id;
    if (nestKey && r[nestKey]) values[nestKey] = ids.get(String(r[nestKey])) ?? null;
    values[ownerKey] = to[parentOwnerKey];
    if (customerKey && parentCustomerKey) values[customerKey] = to[parentCustomerKey];
    if (columns.createdBy) values.createdBy = p.actor.kind === 'agent' ? 'assistant' : 'person';
    return values;
  });
  const made = await insertChunks(tx, link.table, copies);
  out.children[link.child.name] = [...(out.children[link.child.name] ?? []), ...made];
  for (const r of made)
    out.touched.push({ type: link.child.name, id: String(r.id), change: 'created', after: r });
  // Grandchildren: under each copied node, the copies of the old node's own children.
  for (const sub of childLinksOf(link.child.name))
    for (const [oldId, newId] of ids) {
      const copy = made.find((r) => r.id === newId);
      if (copy) await copyChildren(tx, p, sub, oldId, copy, out);
    }
}

/**
 * The next revision of a record (`traits.versioned.revisions`): a copy in the same series, with
 * the same owner and customer, `revision` one more than the series' highest, version 1, its
 * state machine's initial state, and `values` over it (a new number, say); then a copy of every
 * child tree under it. Files stay with the old revision. The principal must be able to write
 * the old revision (tried first: 404 or a rule's refusal). Call it in a command's run, list
 * `touched` in its result, and freeze the old revision in the same write.
 */
export async function reviseWithChildren(
  tx: Tx,
  p: Principal,
  def: AnyEntityDef,
  row: Values,
  opts: { via: RuleContext; values?: Values },
): Promise<Revision> {
  const trait = versionedOf(def.spec);
  const rev = trait ? revisionFields(trait) : undefined;
  if (!trait || !rev) throw new Error(`${def.name} has no revisions (traits.versioned.revisions)`);
  await assertWritable(tx, p, def, row, opts.via);
  const columns = getTableColumns(def.table) as Record<string, Column>;
  const series = (row[rev.series] as string | null) ?? String(row.id);
  const seriesCol = columns[rev.series] as Column;
  const numberCol = columns[rev.number] as Column;
  const [top] = await tx
    .select({ n: max(numberCol) })
    .from(def.table as Table)
    .where(
      and(
        eq(columns.tenantId as Column, row.tenantId as string),
        sql`coalesce(${seriesCol}, ${columns.id}) = ${series}`,
      ),
    );
  const values: Values = { ...row };
  for (const s of STAMPS) delete values[s];
  withoutFiles(def.spec, columns, values);
  Object.assign(values, {
    id: randomUUID(),
    [versionField(trait)]: 1,
    [rev.series]: series,
    [rev.number]: Number(top?.n ?? row[rev.number] ?? 1) + 1,
  });
  const states = statesOf(def.spec);
  if (states) values[states.field] = states.initial;
  if (columns.createdBy) values.createdBy = p.actor.kind === 'agent' ? 'assistant' : 'person';
  // The application's own changes, but never who it belongs to or which series it is in.
  const fixed = new Set([
    'id',
    'tenantId',
    'ownerId',
    'customerId',
    'createdBy',
    rev.series,
    rev.number,
    versionField(trait),
  ]);
  for (const [k, v] of Object.entries(opts.values ?? {}))
    if (columns[k] && !fixed.has(k)) values[k] = v;
  const [made] = (await tx
    .insert(def.table as Table)
    .values(values as never)
    .returning()) as Values[];
  const out: Revision = {
    row: made,
    children: {},
    touched: [{ type: def.name, id: String(made.id), change: 'created', after: made }],
  };
  for (const link of childLinksOf(def.name))
    await copyChildren(tx, p, link, String(row.id), made, out);
  return out;
}

/**
 * The revisions of a record's series in its business, oldest first: raw rows, not yet scoped
 * to a reader (read each through the entity's repository before it leaves).
 */
export async function seriesIds(
  conn: Pick<Tx, 'select'>,
  def: AnyEntityDef,
  row: Values,
  limit = 50,
): Promise<string[]> {
  const trait = versionedOf(def.spec);
  const rev = trait ? revisionFields(trait) : undefined;
  if (!rev) return [String(row.id)];
  const columns = getTableColumns(def.table) as Record<string, Column>;
  const series = (row[rev.series] as string | null) ?? String(row.id);
  const rows = await conn
    .select({ id: sql<string>`${columns.id}` })
    .from(def.table as Table)
    .where(
      and(
        eq(columns.tenantId as Column, row.tenantId as string),
        sql`coalesce(${columns[rev.series]}, ${columns.id}) = ${series}`,
      ),
    )
    .orderBy(sql`${columns[rev.number]}`)
    .limit(limit);
  return rows.map((r) => String((r as Values).id));
}
