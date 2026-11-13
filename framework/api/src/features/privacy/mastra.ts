// The assistant's own records of a person (B18): Mastra keeps run snapshots and score results
// in the `mastra` schema and traces, logs, scores, metrics and feedback in `mastra_obs`, outside
// drizzle's schemas. They are reached here with SQL, by the person's runs (from their threads and the audit
// rows of what was done for them) and by the subject key Mastra records as `userId`. A table
// Mastra has not made yet is skipped. Nothing here loads Nest.
import type { Conn, Tx } from '@hykr/core';
import { events as auditEvents, threadMessages, threads } from '@hykr/db';
import { and, eq, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type { Identities } from './subject.js';

/** Mastra's observability tables, each with the column its time is in. */
const OBSERVED = [
  ['mastra_span_events', 'startedAt'],
  ['mastra_log_events', 'timestamp'],
  ['mastra_score_events', 'timestamp'],
  ['mastra_metric_events', 'timestamp'],
  ['mastra_feedback_events', 'timestamp'],
] as const;

const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

/** Is this table there (Mastra made it)? */
async function exists(conn: Conn, qualified: string): Promise<boolean> {
  const r = await conn.execute(sql`select to_regclass(${qualified}) is not null as ok`);
  return Boolean((r as unknown as { rows: { ok: boolean }[] }).rows[0]?.ok);
}

const rowsOf = (r: unknown) => (r as { rowCount?: number | null }).rowCount ?? 0;

/**
 * The person's runs in this business: every run of their threads, and every run audit names
 * as done for them or by them (an assistant's write, a contact's).
 */
export async function runsOf(conn: Conn, ids: Identities): Promise<string[]> {
  const owners: SQL[] = [];
  if (ids.userId) owners.push(eq(threads.ownerId, ids.userId));
  if (ids.contactIds.length) owners.push(inArray(threads.contactId, ids.contactIds));
  const runs = new Set<string>();
  if (owners.length) {
    const said = await conn
      .selectDistinct({ runId: threadMessages.runId })
      .from(threadMessages)
      .innerJoin(threads, eq(threads.id, threadMessages.threadId))
      .where(
        and(eq(threads.tenantId, ids.tenantId), or(...owners), isNotNull(threadMessages.runId)),
      );
    for (const r of said) if (r.runId) runs.add(r.runId);
  }
  const actors = [ids.userId, ...ids.contactIds].filter((x): x is string => !!x);
  const forThem = [...actors, ...ids.keys];
  const done = await conn
    .selectDistinct({ runId: auditEvents.runId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, ids.tenantId),
        isNotNull(auditEvents.runId),
        or(inArray(auditEvents.actingFor, forThem), inArray(auditEvents.actorId, actors)),
      ),
    );
  for (const r of done) if (r.runId) runs.add(r.runId);
  return [...runs].sort();
}

/** Mastra's stored score results (the scorers on every turn), outside `mastra_obs`. */
const SCORERS = 'mastra.mastra_scorers';

/**
 * The traces of the scorers that scored these runs: a scorer's spans name the run only as
 * `metadataRaw.targetTraceId`, and its score event as `scoreTraceId`.
 */
async function scorerTraces(conn: Conn, runs: readonly string[]): Promise<string[]> {
  if (!runs.length) return [];
  const found = new Set<string>();
  const read = async (q: SQL) => {
    const r = (await conn.execute(q)) as unknown as { rows: { t: string | null }[] };
    for (const row of r.rows) if (row.t) found.add(row.t);
  };
  if (await exists(conn, 'mastra_obs.mastra_score_events'))
    await read(sql`select distinct "scoreTraceId" as t from mastra_obs.mastra_score_events
      where "runId" in (${list(runs)}) or "traceId" in (${list(runs)})`);
  if (await exists(conn, 'mastra_obs.mastra_span_events'))
    await read(sql`select distinct "traceId" as t from mastra_obs.mastra_span_events
      where "metadataRaw" ->> 'targetTraceId' in (${list(runs)})`);
  for (const r of runs) found.delete(r);
  return [...found].sort();
}

/** Rows naming the person or one of their runs (or a scorer's trace of one), in this business. */
function theirs(ids: Identities, runs: readonly string[], scored: readonly string[] = []): SQL {
  const subjects = [ids.userId, ...ids.keys].filter((x): x is string => !!x);
  const traces = [...runs, ...scored];
  const byRun = runs.length
    ? sql`"runId" in (${list(runs)}) or "traceId" in (${list(traces)})`
    : null;
  const byPerson = sql`("userId" in (${list(subjects)}) and "requestContext" ->> 'tenantId' = ${ids.tenantId})`;
  return byRun ? sql`(${byRun} or ${byPerson})` : byPerson;
}

/**
 * Delete what Mastra keeps of the person: their runs' traces and snapshots, and their memory.
 * Mastra's memory is keyed by subject, not by business: a contact's key is this business's, a
 * person's only once they are in no other business (`everywhere`).
 */
export async function eraseMastra(
  tx: Tx,
  ids: Identities,
  runs: readonly string[],
  everywhere: boolean,
): Promise<number> {
  let n = 0;
  // The scorers' own traces (each scorer run is a trace of its own, naming the run it scored
  // only in its metadata): read before their score events go.
  const scored = await scorerTraces(tx, runs);
  const traces = [...runs, ...scored];
  for (const [table] of OBSERVED) {
    const name = `mastra_obs.${table}`;
    if (!(await exists(tx, name))) continue;
    // Only span events carry the request context; the others go by run or subject alone.
    const byRun = runs.length
      ? sql`("runId" in (${list(runs)}) or "traceId" in (${list(traces)}))`
      : null;
    const where = table === 'mastra_span_events' ? theirs(ids, runs, scored) : byRun;
    if (!where) continue;
    n += rowsOf(await tx.execute(sql`delete from ${sql.raw(name)} where ${where}`));
  }
  if (runs.length && (await exists(tx, 'mastra.mastra_workflow_snapshot')))
    n += rowsOf(
      await tx.execute(
        sql`delete from mastra.mastra_workflow_snapshot where run_id in (${list(runs)})`,
      ),
    );
  // The scorers' results: each keeps the turn's input and output, by the run it scored.
  if (runs.length && (await exists(tx, SCORERS)))
    n += rowsOf(
      await tx.execute(
        sql`delete from ${sql.raw(SCORERS)}
            where "runId" in (${list(runs)}) or "traceId" in (${list(runs)})`,
      ),
    );
  // Mastra's own memory, keyed by resource: the framework keeps conversations itself, but an
  // agent with memory would key them by the subject.
  const resources = everywhere ? ids.keys : ids.keys.filter((k) => k.startsWith('contact:'));
  if (!resources.length) return n;
  if (await exists(tx, 'mastra.mastra_messages'))
    n += rowsOf(
      await tx.execute(
        sql`delete from mastra.mastra_messages where "resourceId" in (${list(resources)})`,
      ),
    );
  if (await exists(tx, 'mastra.mastra_threads'))
    n += rowsOf(
      await tx.execute(
        sql`delete from mastra.mastra_threads where "resourceId" in (${list(resources)})`,
      ),
    );
  if (await exists(tx, 'mastra.mastra_resources'))
    n += rowsOf(
      await tx.execute(sql`delete from mastra.mastra_resources where id in (${list(resources)})`),
    );
  return n;
}

/** The person's assistant runs, for their export: when each ran and how many steps it traced. */
export async function exportMastra(
  conn: Conn,
  ids: Identities,
  runs: readonly string[],
): Promise<Record<string, unknown>[]> {
  if (!(await exists(conn, 'mastra_obs.mastra_span_events'))) return [];
  const r = await conn.execute(sql`
    select coalesce("runId", "traceId") as "runId", min("startedAt") as "startedAt",
           count(*)::int as spans
    from mastra_obs.mastra_span_events
    where ${theirs(ids, runs)}
    group by 1 order by 2`);
  return (
    r as unknown as { rows: { runId: string; startedAt: Date | string; spans: number }[] }
  ).rows.map((row) => ({
    runId: row.runId,
    startedAt: new Date(row.startedAt).toISOString(),
    spans: row.spans,
  }));
}

/**
 * Traces and score results older than `before`, for the whole deployment (the
 * `assistant.traces` target).
 */
export async function expireTraces(tx: Tx, before: Date): Promise<number> {
  let n = 0;
  for (const [table, at] of OBSERVED) {
    const name = `mastra_obs.${table}`;
    if (!(await exists(tx, name))) continue;
    n += rowsOf(
      await tx.execute(
        sql`delete from ${sql.raw(name)} where ${sql.identifier(at)} < ${before.toISOString()}`,
      ),
    );
  }
  // `createdAtZ`: the time with its zone (`createdAt` is UTC without one).
  if (await exists(tx, SCORERS))
    n += rowsOf(
      await tx.execute(
        sql`delete from ${sql.raw(SCORERS)} where "createdAtZ" < ${before.toISOString()}`,
      ),
    );
  return n;
}
