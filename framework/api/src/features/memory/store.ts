// The memory index (app.memory_index): rows to embed, rows to search. It holds no text; recall
// loads each source again as the reader (recall.service.ts).
import type { RecallKind } from '@hykr/contracts';
import type { Conn } from '@hykr/core';
import { memoryIndex, threadMessages } from '@hykr/db';
import { Logger } from '@nestjs/common';
import { and, eq, getTableColumns, inArray, sql, type Table } from 'drizzle-orm';

const log = new Logger('Memory');

let pgvector: Promise<boolean> | undefined;

/**
 * Whether this database has pgvector: then distance is measured with `<=>`; otherwise with
 * app.memory_cosine over the stored real[]. Asked once per process, and logged.
 */
export function hasPgvector(db: Conn): Promise<boolean> {
  pgvector ??= db
    .execute(sql`select exists (select 1 from pg_extension where extname = 'vector') as found`)
    .then((r) => Boolean((r.rows[0] as { found?: boolean } | undefined)?.found))
    .then((found) => {
      log.log(
        found
          ? 'Memory recall measures distance with pgvector'
          : 'Memory recall measures cosine over real[] (pgvector is not installed)',
      );
      return found;
    })
    .catch((e) => {
      pgvector = undefined;
      throw e;
    });
  return pgvector;
}

/** A vector as a Postgres literal: '{0.1,0.2}' (real[]) or '[0.1,0.2]' (vector). */
const realArray = (v: readonly number[]) => `{${v.map(finite).join(',')}}`;
const vectorText = (v: readonly number[]) => `[${v.map(finite).join(',')}]`;
const finite = (x: number) => (Number.isFinite(x) ? x : 0);

/** Cosine similarity of the stored vector to `q`, as SQL: 1 is the same direction. */
export function similarity(vector: boolean, q: readonly number[]) {
  return vector
    ? sql`(1 - (${memoryIndex.embedding}::vector <=> ${vectorText(q)}::vector))`
    : sql`app.memory_cosine(${memoryIndex.embedding}, ${realArray(q)}::real[])`;
}

/** One search candidate: where it came from, and how close it is. */
export interface Candidate {
  kind: RecallKind;
  sourceType: string;
  sourceId: string;
  messageId: string | null;
  aboutType: string | null;
  aboutId: string | null;
  score: number;
}

/**
 * The nearest indexed memories of one business made by one model, best first: records (of the
 * given types, and of one record when `about` says so) and, with `subject`, that person's words
 * (except the messages in `exclude`). Nothing here is checked for the reader yet.
 */
export async function nearest(
  db: Conn,
  a: {
    tenantId: string;
    model: string;
    vector: readonly number[];
    minScore: number;
    limit: number;
    records: boolean;
    about?: { type: string; id: string };
    subject?: string;
    exclude?: readonly string[];
  },
): Promise<Candidate[]> {
  const score = similarity(await hasPgvector(db), a.vector);
  const record = a.records
    ? and(
        eq(memoryIndex.kind, 'record'),
        a.about ? eq(memoryIndex.aboutType, a.about.type) : undefined,
        a.about ? eq(memoryIndex.aboutId, a.about.id) : undefined,
      )
    : undefined;
  const message =
    a.subject && !a.about
      ? and(
          eq(memoryIndex.kind, 'message'),
          eq(memoryIndex.subject, a.subject),
          a.exclude?.length
            ? sql`not (${inArray(memoryIndex.messageId, [...a.exclude])})`
            : undefined,
        )
      : undefined;
  const which = [record, message].filter(Boolean);
  if (!which.length) return [];
  const result = await db.execute(sql`
    select * from (
      select ${memoryIndex.kind} as kind, ${memoryIndex.sourceType} as "sourceType",
        ${memoryIndex.sourceId} as "sourceId", ${memoryIndex.messageId} as "messageId",
        ${memoryIndex.aboutType} as "aboutType", ${memoryIndex.aboutId} as "aboutId",
        ${score} as score
      from ${memoryIndex}
      where ${memoryIndex.tenantId} = ${a.tenantId}
        and ${memoryIndex.model} = ${a.model}
        and ${memoryIndex.state} = 'ready'
        and (${sql.join(which as ReturnType<typeof sql>[], sql` or `)})
    ) found
    where score >= ${a.minScore}
    order by score desc
    limit ${a.limit}`);
  return (result.rows as unknown as Candidate[]).map((r) => ({ ...r, score: Number(r.score) }));
}

/** The latest `n` messages of a thread: already in the model's history, so not recalled. */
export async function recentMessages(db: Conn, threadId: string, n: number): Promise<string[]> {
  const rows = await db
    .select({ id: threadMessages.id })
    .from(threadMessages)
    .where(eq(threadMessages.threadId, threadId))
    .orderBy(sql`${threadMessages.seq} desc`)
    .limit(n);
  return rows.map((r) => r.id);
}

/**
 * A record to (re-)embed: pending, for this process's indexer. Any claim goes, so a run that is
 * embedding the record's old words writes nothing (indexer.ts).
 */
export async function markPending(
  tx: Conn,
  a: { tenantId: string; type: string; id: string; queues: string },
) {
  await tx
    .insert(memoryIndex)
    .values({
      tenantId: a.tenantId,
      kind: 'record',
      sourceType: a.type,
      sourceId: a.id,
      queues: a.queues,
    })
    .onConflictDoUpdate({
      target: [memoryIndex.tenantId, memoryIndex.sourceType, memoryIndex.sourceId],
      set: {
        state: 'pending',
        queues: a.queues,
        attempts: 0,
        error: null,
        claim: null,
        claimedAt: null,
        updatedAt: sql`now()`,
      },
    });
}

/** A record that is gone, or no longer memory: its vector goes. */
export async function forget(tx: Conn, a: { tenantId: string; type: string; id: string }) {
  await tx
    .delete(memoryIndex)
    .where(
      and(
        eq(memoryIndex.tenantId, a.tenantId),
        eq(memoryIndex.sourceType, a.type),
        eq(memoryIndex.sourceId, a.id),
      ),
    );
}

/**
 * Something a person said, with the vector recall already made for it: searchable at once.
 * Keyed by business and person (`subject`), across their threads and channels.
 */
export async function keepMessage(
  db: Conn,
  a: { tenantId: string; messageId: string; subject: string; model: string; vector: number[] },
) {
  await db
    .insert(memoryIndex)
    .values({
      tenantId: a.tenantId,
      kind: 'message',
      sourceType: 'message',
      sourceId: a.messageId,
      messageId: a.messageId,
      subject: a.subject,
      model: a.model,
      embedding: a.vector,
      state: 'ready',
    })
    .onConflictDoNothing();
}

/**
 * Pending rows for every record of a memory entity that has none (records written before the
 * entity had the trait, or before this feature): one statement per entity, for one business or
 * every one.
 */
export async function backfill(
  db: Conn,
  a: { type: string; table: Table; tenantId?: string; queues: string },
): Promise<number> {
  const columns = getTableColumns(a.table);
  const id = columns.id;
  const tenant = columns.tenantId;
  if (!id || !tenant) return 0;
  const result = await db.execute(sql`
    insert into ${memoryIndex} (tenant_id, kind, source_type, source_id, queues)
    select ${tenant}, 'record', ${a.type}, ${id}, ${a.queues}
    from ${a.table}
    ${a.tenantId ? sql`where ${tenant} = ${a.tenantId}` : sql``}
    on conflict (tenant_id, source_type, source_id) do nothing`);
  return result.rowCount ?? 0;
}

/**
 * Every vector of one business again (its embedding model changed): pending, for `queues`; a run
 * embedding with the old model writes nothing.
 */
export async function reindexAll(db: Conn, a: { tenantId: string; queues: string }) {
  const result = await db
    .update(memoryIndex)
    .set({
      state: 'pending',
      queues: a.queues,
      attempts: 0,
      error: null,
      claim: null,
      claimedAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(memoryIndex.tenantId, a.tenantId));
  return result.rowCount ?? 0;
}
