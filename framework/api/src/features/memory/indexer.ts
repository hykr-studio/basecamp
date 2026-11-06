import { MemoryRead, memoryTraitOf } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type Conn,
  type CoreOptions,
  entityDef,
  entityDefs,
  eventQueues,
  systemPrincipal,
  type Tx,
  type WriteHook,
} from '@hykr/core';
import { type Database, memoryIndex, threadMessages } from '@hykr/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { embedMany } from 'ai';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ModelPolicyService, ModelRefused } from '../models/model-policy.service.js';
import { backfill, forget, markPending, reindexAll } from './store.js';

const log = new Logger('Memory');
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Rows embedded per tick and transaction. */
const BATCH = 50;
/** How often the worker looks for rows to embed. */
const EVERY_MS = 1000;
/** Tries before a row is left `failed` (a policy change retries it). */
const ATTEMPTS = 5;

/**
 * Every write that touches a record of an entity with the `memory` trait (plain CRUD and
 * commands alike: `touched` lists every record a write changed) marks it for the indexer, in the
 * write's transaction: pending, or gone when it was deleted.
 */
export const IndexOnWrite: WriteHook = {
  name: 'memory.index',
  async afterRun({ tx, touched, result, ctx }) {
    const tenantId = ctx.principal.tenantId;
    if (result.status !== 'done' || !tenantId) return;
    for (const t of touched) {
      const def = entityDef(t.type);
      if (!def || !memoryTraitOf(def.spec)) continue;
      if (t.change === 'deleted') await forget(tx, { tenantId, type: t.type, id: t.id });
      else await markPending(tx, { tenantId, type: t.type, id: t.id, queues: eventQueues() });
    }
  },
};

/** Who loads a record to index it: the business's own background work, reading memory only. */
const indexer = (tenantId: string) =>
  systemPrincipal({ tenantId, job: 'memory.index', capabilities: [MemoryRead] });

type Row = typeof memoryIndex.$inferSelect;
type Ready = { row: Row; text: string; about?: { type: string; id: string } };

/**
 * The words of one pending row, as a reader with no capabilities but `memory.read` sees its
 * source (fields hidden by capability are never embedded), or null when there is nothing to
 * index any more (the source is gone, no longer memory, or empty).
 */
async function textOf(tx: Conn, row: Row): Promise<Omit<Ready, 'row'> | null> {
  if (row.kind === 'message') {
    if (!row.messageId) return null;
    const [m] = await tx
      .select({ text: threadMessages.text })
      .from(threadMessages)
      .where(and(eq(threadMessages.id, row.messageId), eq(threadMessages.role, 'user')));
    return m?.text.trim() ? { text: m.text.trim() } : null;
  }
  const def = entityDef(row.sourceType);
  const trait = def && memoryTraitOf(def.spec);
  if (!def || !trait) return null;
  const p = indexer(row.tenantId);
  const found = await def.repo.find(tx, p, row.sourceId);
  if (!found) return null;
  const read = def.toRead(found, p) as Record<string, unknown>;
  const text = trait.text(read)?.trim();
  if (!text) return null;
  const about = trait.about?.(read) ?? undefined;
  return { text, ...(about ? { about: { type: about.type, id: about.id } } : {}) };
}

/**
 * The worker's memory indexer: each second, this process's pending rows (its queue prefix) are
 * embedded with their business's embedding model, a business at a time, under `FOR UPDATE SKIP
 * LOCKED` so two workers never embed the same row. A source that is gone leaves the index. A
 * business whose policy refuses every embedding model has its rows marked `failed` (a policy
 * change retries them); a provider error retries with backoff, then fails.
 */
@Injectable()
export class MemoryIndexer implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
  }

  onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** Embed until nothing is pending (one batch at a time); errors are logged. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && (await this.batch()) > 0) {}
    } catch (e) {
      log.error(`indexing failed: ${reason(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** One batch: how many rows it settled. */
  async batch(): Promise<number> {
    return (this.core.db as Database).transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(memoryIndex)
        .where(
          and(
            eq(memoryIndex.queues, eventQueues()),
            eq(memoryIndex.state, 'pending'),
            // Backoff: a row that failed n times waits 2^n - 1 seconds.
            sql`${memoryIndex.updatedAt} <= now() - make_interval(secs => power(2, ${memoryIndex.attempts}) - 1)`,
          ),
        )
        .orderBy(asc(memoryIndex.updatedAt))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      const byTenant = new Map<string, Row[]>();
      for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
      for (const [tenantId, group] of byTenant) await this.embedFor(tx, tenantId, group);
      return rows.length;
    });
  }

  private async embedFor(tx: Tx, tenantId: string, rows: Row[]) {
    const ready: Ready[] = [];
    const gone: string[] = [];
    for (const row of rows) {
      const found = await textOf(tx, row);
      if (found) ready.push({ row, ...found });
      else gone.push(row.id);
    }
    if (gone.length) await tx.delete(memoryIndex).where(inArray(memoryIndex.id, gone));
    if (!ready.length) return;
    const ids = ready.map((r) => r.row.id);
    let model: string;
    let vectors: number[][];
    try {
      const models = this.ref.get(ModelPolicyService, { strict: false });
      const chosen = await models.embeddingFor(tenantId);
      model = chosen.ref;
      ({ embeddings: vectors } = await embedMany({
        model: chosen.model,
        values: ready.map((r) => r.text),
        maxRetries: 1,
      }));
    } catch (e) {
      const refused = e instanceof ModelRefused;
      if (!refused) log.warn(`business ${tenantId}: embedding failed: ${reason(e)}`);
      await tx
        .update(memoryIndex)
        .set({
          attempts: sql`${memoryIndex.attempts} + 1`,
          state: refused
            ? 'failed'
            : sql`case when ${memoryIndex.attempts} + 1 >= ${ATTEMPTS} then 'failed' else 'pending' end`,
          error: refused ? `model refused: ${e.refusal.rule}` : reason(e).slice(0, 500),
          updatedAt: sql`now()`,
        })
        .where(inArray(memoryIndex.id, ids));
      return;
    }
    for (const [i, r] of ready.entries())
      await tx
        .update(memoryIndex)
        .set({
          model,
          embedding: vectors[i],
          state: 'ready',
          attempts: 0,
          error: null,
          aboutType: r.about?.type ?? null,
          aboutId: r.about?.id ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(memoryIndex.id, r.row.id));
  }
}

/**
 * Pending rows for every record of an entity with the `memory` trait that has none, for one
 * business or every one (records written before the trait or this feature existed). Returns how
 * many it added.
 */
export async function backfillAll(db: Conn, tenantId?: string): Promise<number> {
  let added = 0;
  for (const def of entityDefs()) {
    if (!memoryTraitOf(def.spec)) continue;
    added += await backfill(db, {
      type: def.name,
      table: def.table,
      queues: eventQueues(),
      ...(tenantId ? { tenantId } : {}),
    });
  }
  return added;
}

/**
 * A business's embedding model may have changed: every vector of it is made again (vectors of
 * two models cannot be compared), and records never indexed are added.
 */
export async function rebuild(db: Conn, tenantId: string) {
  const again = await reindexAll(db, { tenantId, queues: eventQueues() });
  const added = await backfillAll(db, tenantId);
  log.log(`business ${tenantId}: ${again} memories to embed again, ${added} new`);
}
