// Reading SLA clocks (GET /api/sla, the sla feature in @hykr/api). A clock is shown exactly when
// its record is in the reader's list of its entity, decided in SQL, a keyset page at a time:
// never a read per record, and never a plan whose cost multiplies the timers by the records. A
// clock carries its record's state, so it is kept from whoever may not see that state, and from
// the assistant where the record's get is not exposed to it. docs/decisions/S3.md.
import {
  fieldPolicyOf,
  hiddenFields,
  type Principal,
  type SlaPage,
  type SlaQuery,
  type SlaTimer,
  statesOf,
  storableInstant,
  textFault,
} from '@hykr/contracts';
import { slaTimers } from '@hykr/db';
import { BadRequestException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import {
  and,
  asc,
  type Column,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import { type AnyEntityDef, tenantOf } from '../entity/define-entity.js';
import { entityDefs } from '../entity/registry.js';
import { listWhere } from '../query/aggregate.js';
import type { Conn } from '../tokens.js';
import { timerOut } from './sla.js';

const log = new Logger('SlaClocks');

type Values = Record<string, unknown>;
type TimerRow = typeof slaTimers.$inferSelect;

/**
 * Are this entity's clocks served to p at all: as its records are over the API. Nobody reads an
 * `internal` entity's records there, and the assistant reads only those whose get is exposed to
 * it (the rule files, comments, jobs and documents follow).
 */
export function clocksServed(def: Pick<AnyEntityDef, 'spec'>, p: Principal): boolean {
  const get = def.spec.expose.get;
  if (get === 'internal') return false;
  return !(p.actor.kind === 'agent' && get !== 'all');
}

/** Does the entity's field policy hide its state field from p (so, every record's state)? */
export function stateFieldHidden(def: Pick<AnyEntityDef, 'spec'>, p: Principal): boolean {
  const trait = statesOf(def.spec);
  return !!trait && hiddenFields(fieldPolicyOf(def.spec), p).includes(trait.field);
}

/** Does p's projection of this record keep its state field (removed, never blanked)? */
function stateShown(def: AnyEntityDef, row: unknown, p: Principal): boolean {
  const trait = statesOf(def.spec);
  return !trait || Object.hasOwn(def.toRead(row as never, p) as Values, trait.field);
}

/** Where the next page starts: the last row's due time (UTC, to the microsecond) and its id. */
export interface SlaCursor {
  d: string;
  i: string;
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

const badCursor = () =>
  new BadRequestException({ error: 'bad_cursor', message: 'This cursor is not valid' });

export const encodeSlaCursor = (c: SlaCursor): string =>
  Buffer.from(JSON.stringify({ d: c.d, i: c.i })).toString('base64url');

/** A page's `nextCursor`, back; anything else is a 400. */
export function decodeSlaCursor(cursor: string): SlaCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  const c = (parsed ?? {}) as { d?: unknown; i?: unknown };
  if (typeof c.d !== 'string' || !CURSOR_TIME.test(c.d)) throw badCursor();
  // An id Postgres can hold: no NUL, no half of a surrogate pair (V10).
  if (typeof c.i !== 'string' || !c.i || c.i.length > 100 || textFault(c.i)) throw badCursor();
  // A real instant Postgres can store: no 31 February rolling into March, and no year 0000,
  // which JavaScript reads and `::timestamptz` refuses (V10).
  const at = storableInstant(`${c.d}Z`);
  if (!at || at.toISOString().slice(0, 19) !== c.d.slice(0, 19)) throw badCursor();
  return { d: c.d, i: c.i };
}

/**
 * A due time as Postgres keeps it, to the microsecond: a JavaScript Date keeps milliseconds, and
 * a page cut on one would repeat or skip rows due within the same millisecond.
 */
const dueKey = sql<string>`to_char(${slaTimers.dueAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/** The rows after the cursor, in (due_at, id) order; `due_at >= d` lets the due index serve it. */
function afterCursor(c: SlaCursor): SQL {
  const at = sql`${`${c.d}Z`}::timestamptz`;
  return and(gte(slaTimers.dueAt, at), or(gt(slaTimers.dueAt, at), gt(slaTimers.id, c.i))) as SQL;
}

/** Entities whose scope could not be read as one WHERE, logged once each. */
const unlisted = new Set<string>();

/**
 * The WHERE of the entity's list for p (its business, p's grants, every plugin's scope), or
 * undefined when it cannot be read as one: then its clocks are not listed (fail closed). A shared
 * entity lists in two queries where a platform business exists; a business's timers are only on
 * its own rows, which its record's own clocks route still serves.
 */
async function reachOf(def: AnyEntityDef, p: Principal): Promise<SQL | undefined> {
  try {
    return await listWhere(def, p, { filters: [] });
  } catch (e) {
    // A plugin refusing this reader the entity: nothing of it for them.
    if (e instanceof HttpException) return undefined;
    if (!unlisted.has(def.name)) {
      unlisted.add(def.name);
      log.warn(`${def.name}: its SLA clocks are left out of lists: ${(e as Error).message}`);
    }
    return undefined;
  }
}

/**
 * Up to this many records of an entity in the reader's reach, its timers are read by record (the
 * resource index); past it, by due time with one primary-key probe per timer.
 */
export const SLA_BY_RECORD = 1_000;

export interface SlaBranch {
  def: AnyEntityDef;
  /** The entity's list WHERE for the reader. */
  where: SQL;
  /** Every record in reach, when there are at most SLA_BY_RECORD. */
  ids?: string[];
}

/**
 * The timers of this branch's records: by record when the reader reaches few, else a probe of
 * the record per timer. The probe is fenced (`offset 0`) so it stays a per-row lookup by primary
 * key: a semi-join would let a misestimate (a new business, fresh rows) pick a nested loop that
 * scans every record in reach for every timer, seconds at 20,000 timers.
 */
export function reachSql(branch: SlaBranch): SQL {
  if (branch.ids) return sql`${slaTimers.resourceId} = any(${sql.param(branch.ids)}::text[])`;
  const idCol = (getTableColumns(branch.def.table) as Record<string, Column>).id;
  return sql`exists (select 1 from ${branch.def.table} where ${idCol} = ${slaTimers.resourceId} and ${branch.where} offset 0)`;
}

/**
 * The records of these timers whose state p sees, as `<type>:<id>`: each type's records on the
 * page read once, in p's reach, through `toRead`.
 */
async function statesSeen(
  conn: Conn,
  p: Principal,
  branches: ReadonlyMap<string, SlaBranch>,
  timers: readonly TimerRow[],
): Promise<Set<string>> {
  const seen = new Set<string>();
  const ids = new Map<string, Set<string>>();
  for (const t of timers) {
    const set = ids.get(t.resourceType) ?? new Set<string>();
    set.add(t.resourceId);
    ids.set(t.resourceType, set);
  }
  for (const [type, set] of ids) {
    const branch = branches.get(type);
    if (!branch) continue;
    const idCol = (getTableColumns(branch.def.table) as Record<string, Column>).id;
    const rows = (await conn
      .select()
      .from(branch.def.table as Table)
      .where(and(branch.where, inArray(idCol, [...set])))) as Values[];
    for (const row of rows)
      if (stateShown(branch.def, row, p)) seen.add(`${type}:${String(row.id)}`);
  }
  return seen;
}

/**
 * The business's clocks in one status on records p reads, earliest due first (then by id), one
 * keyset page at a time. For each entity with a state machine whose clocks p may see, one branch
 * keeps the timers whose record is in p's list of it (the entity's own list WHERE): read by
 * record when p reaches at most SLA_BY_RECORD of them (none: no timer is read at all), else by
 * due time with a primary-key probe per timer. Postgres orders and cuts each branch and merges
 * them. The page's records are then read once more in p's reach, through `toRead`: a clock whose
 * record left the reach meanwhile, or whose state p's projection hides, is dropped, so a page can
 * hold fewer than `limit` and still have a next one.
 */
export async function listSlaTimers(conn: Conn, p: Principal, q: SlaQuery): Promise<SlaPage> {
  const tenantId = tenantOf(p);
  const after = q.cursor ? decodeSlaCursor(q.cursor) : undefined;
  const branches = new Map<string, SlaBranch>();
  for (const def of entityDefs()) {
    if (!statesOf(def.spec) || (q.resourceType && def.name !== q.resourceType)) continue;
    if (!clocksServed(def, p) || stateFieldHidden(def, p)) continue;
    const where = await reachOf(def, p);
    if (!where) continue;
    const idCol = (getTableColumns(def.table) as Record<string, Column>).id;
    const few = (await conn
      .select({ id: sql<string>`${idCol}` })
      .from(def.table as Table)
      .where(where)
      .limit(SLA_BY_RECORD + 1)) as { id: unknown }[];
    if (!few.length) continue;
    branches.set(def.name, {
      def,
      where,
      ...(few.length <= SLA_BY_RECORD ? { ids: few.map((r) => String(r.id)) } : {}),
    });
  }
  if (!branches.size) return { items: [], nextCursor: null };

  // Ended or not is decided here, before any limit: a client that dropped ended breaches itself
  // would get none once the earliest `limit` had all ended.
  const open =
    q.open === undefined
      ? undefined
      : q.open
        ? isNull(slaTimers.endedAt)
        : isNotNull(slaTimers.endedAt);
  const base = and(eq(slaTimers.tenantId, tenantId), eq(slaTimers.status, q.status), open);
  const cut = q.limit + 1;
  const selects = [...branches.values()].map((branch) =>
    conn
      .select({ id: slaTimers.id, dueAt: slaTimers.dueAt, dueKey: dueKey.as('due_key') })
      .from(slaTimers)
      .where(
        and(
          base,
          eq(slaTimers.resourceType, branch.def.name),
          after ? afterCursor(after) : undefined,
          reachSql(branch),
        ),
      )
      .orderBy(asc(slaTimers.dueAt), asc(slaTimers.id))
      .limit(cut),
  );
  // Each select renders in parentheses: (…) union all (…), ordered and cut once more.
  const merged = sql.join(
    selects.map((s) => sql`${s}`),
    sql` union all `,
  );
  const keys = (
    await conn.execute(
      sql`select ${sql.identifier('id')}, ${sql.identifier('due_key')} from (${merged}) as ${sql.identifier('page')} order by ${sql.identifier('due_at')}, ${sql.identifier('id')} limit ${cut}`,
    )
  ).rows as { id: string; due_key: string }[];

  const onPage = keys.slice(0, q.limit);
  const last = onPage.at(-1);
  const nextCursor =
    keys.length > q.limit && last ? encodeSlaCursor({ d: last.due_key, i: last.id }) : null;
  if (!onPage.length) return { items: [], nextCursor };

  // The page's timers as stored, still in the status asked (the sweeper may have moved one).
  const timers = await conn
    .select()
    .from(slaTimers)
    .where(
      and(
        base,
        inArray(
          slaTimers.id,
          onPage.map((k) => k.id),
        ),
      ),
    );
  const seen = await statesSeen(conn, p, branches, timers);
  const byId = new Map(timers.map((t) => [t.id, t]));
  const items: SlaTimer[] = [];
  for (const k of onPage) {
    const t = byId.get(k.id);
    if (t && seen.has(`${t.resourceType}:${t.resourceId}`)) items.push(timerOut(t));
  }
  return { items, nextCursor };
}

/**
 * One record's clocks, oldest first, as its entity's read allows: 404 when p cannot read the
 * record or is not served its clocks (the assistant on an entity whose get is not exposed to it),
 * none when p cannot see the record's state.
 */
export async function recordSlaTimers(
  conn: Conn,
  p: Principal,
  def: AnyEntityDef,
  id: string,
): Promise<SlaTimer[]> {
  if (!clocksServed(def, p))
    throw new NotFoundException({ error: 'not_found', message: `No such ${def.spec.label}` });
  const row = await def.repo.get(conn, p, id);
  if (!stateShown(def, row, p)) return [];
  const rows = await conn
    .select()
    .from(slaTimers)
    .where(
      and(
        eq(slaTimers.tenantId, tenantOf(p)),
        eq(slaTimers.resourceType, def.name),
        eq(slaTimers.resourceId, id),
      ),
    )
    .orderBy(asc(slaTimers.startedAt));
  return rows.map(timerOut);
}
