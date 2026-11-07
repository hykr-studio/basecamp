import { randomUUID } from 'node:crypto';
import { MemoryRead, memoryTraitOf } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type Conn,
  type CoreOptions,
  entityDef,
  entityDefs,
  eventQueues,
  systemPrincipal,
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
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { metering } from '../../metering.js';
import { FrameworkMeters } from '../credits/meters.js';
import { ModelPolicyService, ModelRefused } from '../models/model-policy.service.js';
import { backfill, forget, markPending, reindexAll } from './store.js';

const log = new Logger('Memory');
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Rows claimed and embedded per batch. */
const BATCH = 50;
/** How often the worker looks for rows to embed. */
const EVERY_MS = 1000;
/** Tries before a row is left `failed` (a policy change retries it). */
const ATTEMPTS = 5;
/** How long one batch's embedding call may take before it is abandoned (and retried). */
const EMBED_TIMEOUT_MS = 30_000;
/** A claim older than this is taken over: its run died. Well past `EMBED_TIMEOUT_MS`. */
const LEASE_SECONDS = 120;
/** How long a business paused at its credit cap is left alone before the indexer looks again. */
export const PAUSED_WAIT_MS = 60_000;

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
 * embedded with their business's embedding model, a business at a time. Rows are claimed in a
 * short transaction of their own (`FOR UPDATE SKIP LOCKED`, so two workers never take the same
 * row) and nothing stays locked while the provider answers: a write to a record waits for no
 * network. Each result is written only while the row still carries this run's claim, so a write
 * that marked the row pending again in the meantime wins, and the row is embedded again. A claim
 * older than the lease (a run that died) is taken over. A source that is gone leaves the index. A
 * business whose policy refuses every embedding model has its rows marked `failed` (a policy
 * change retries them); a provider error or timeout retries with backoff, then fails. A business
 * paused at its credit cap embeds nothing: its rows wait, and the indexer looks again after
 * PAUSED_WAIT_MS (H3). Each batch's tokens are metered for its business.
 */
@Injectable()
export class MemoryIndexer implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private readonly stop = new AbortController();
  /** Businesses paused at their credit cap, until when this process leaves their rows alone. */
  private readonly paused = new Map<string, number>();

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
    this.stop.abort();
  }

  /**
   * Look at a paused business (or every one) again on the next batch, rather than after
   * PAUSED_WAIT_MS: for a caller that knows it has credits again.
   */
  wake(tenantId?: string) {
    if (tenantId) this.paused.delete(tenantId);
    else this.paused.clear();
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

  /** One batch: how many rows it claimed. */
  async batch(): Promise<number> {
    const db = this.core.db as Database;
    const claim = randomUUID();
    const now = Date.now();
    for (const [tenantId, until] of this.paused) if (until <= now) this.paused.delete(tenantId);
    const rows = await claimRows(db, claim, [...this.paused.keys()]);
    const byTenant = new Map<string, Row[]>();
    for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
    for (const [tenantId, group] of byTenant) await this.embedFor(db, claim, tenantId, group);
    return rows.length;
  }

  /**
   * One business's claimed rows: loaded, embedded with no transaction open, and settled one row
   * at a time (a single-row statement, so the indexer only ever waits for a writer, never the
   * other way round), each only while it still carries `claim`.
   */
  private async embedFor(db: Database, claim: string, tenantId: string, rows: Row[]) {
    const ready: Ready[] = [];
    for (const row of rows) {
      let found: Omit<Ready, 'row'> | null;
      try {
        // A source that fails to load (a trait that throws) fails alone.
        found = await textOf(db, row);
      } catch (e) {
        log.warn(`${row.sourceType} ${row.sourceId}: cannot be indexed: ${reason(e)}`);
        await settle(db, row.id, claim, { state: 'failed', error: reason(e).slice(0, 500) });
        continue;
      }
      if (found) ready.push({ row, ...found });
      else await db.delete(memoryIndex).where(claimed(row.id, claim));
    }
    if (!ready.length) return;
    // A business paused at its credit cap embeds nothing (H3): its rows go back as they were
    // (no attempt counted), and this process leaves it alone for a while.
    const meter = metering();
    const refused = await meter?.check({ tenantId, meter: FrameworkMeters.tokens.name });
    if (refused) {
      log.log(`business ${tenantId}: paused (${refused.rule}), ${ready.length} memories wait`);
      this.paused.set(tenantId, Date.now() + PAUSED_WAIT_MS);
      for (const r of ready)
        await db
          .update(memoryIndex)
          .set({ claim: null, claimedAt: null, updatedAt: sql`${memoryIndex.updatedAt}` })
          .where(claimed(r.row.id, claim));
      return;
    }
    let model: string;
    let vectors: number[][];
    try {
      const models = this.ref.get(ModelPolicyService, { strict: false });
      const chosen = await models.embeddingFor(tenantId);
      model = chosen.ref;
      const out = await embedMany({
        model: chosen.model,
        values: ready.map((r) => r.text),
        maxRetries: 1,
        abortSignal: AbortSignal.any([AbortSignal.timeout(EMBED_TIMEOUT_MS), this.stop.signal]),
      });
      vectors = out.embeddings;
      // What the batch cost the business: one use per business and batch.
      await meter?.record({
        tenantId,
        meter: FrameworkMeters.tokens.name,
        quantity: out.usage?.tokens ?? 0,
        variant: model,
        source: 'memory.index',
        ref: `memory.index:${claim}`,
      });
    } catch (e) {
      // Shutting down: the claims lapse with the lease, and another run takes the rows over.
      if (this.stopped) return;
      const refused = e instanceof ModelRefused;
      if (!refused) log.warn(`business ${tenantId}: embedding failed: ${reason(e)}`);
      for (const r of ready)
        await settle(db, r.row.id, claim, {
          attempts: sql`${memoryIndex.attempts} + 1`,
          state: refused
            ? 'failed'
            : sql`case when ${memoryIndex.attempts} + 1 >= ${ATTEMPTS} then 'failed' else 'pending' end`,
          error: refused ? `model refused: ${e.refusal.rule}` : reason(e).slice(0, 500),
        });
      return;
    }
    for (const [i, r] of ready.entries())
      await settle(db, r.row.id, claim, {
        model,
        embedding: vectors[i],
        state: 'ready',
        attempts: 0,
        error: null,
        aboutType: r.about?.type ?? null,
        aboutId: r.about?.id ?? null,
      });
  }
}

/** The row, while it still carries this run's claim. */
const claimed = (id: string, claim: string) =>
  and(eq(memoryIndex.id, id), eq(memoryIndex.claim, claim));

/**
 * Up to `BATCH` of this process's pending rows, past their backoff and not claimed by a live run,
 * claimed with `claim` in a transaction of their own that commits at once. Rows of the businesses
 * in `skip` (paused at their credit cap) are left where they are.
 */
export function claimRows(
  db: Database,
  claim: string,
  skip: readonly string[] = [],
): Promise<Row[]> {
  return db.transaction(async (tx) => {
    const free = await tx
      .select({ id: memoryIndex.id })
      .from(memoryIndex)
      .where(
        and(
          eq(memoryIndex.queues, eventQueues()),
          eq(memoryIndex.state, 'pending'),
          skip.length ? notInArray(memoryIndex.tenantId, [...skip]) : undefined,
          // Backoff: a row that failed n times waits 2^n - 1 seconds.
          sql`${memoryIndex.updatedAt} <= now() - make_interval(secs => power(2, ${memoryIndex.attempts}) - 1)`,
          or(
            isNull(memoryIndex.claim),
            sql`${memoryIndex.claimedAt} < now() - make_interval(secs => ${LEASE_SECONDS})`,
          ),
        ),
      )
      .orderBy(asc(memoryIndex.updatedAt))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (!free.length) return [];
    return tx
      .update(memoryIndex)
      .set({ claim, claimedAt: sql`now()`, updatedAt: sql`${memoryIndex.updatedAt}` })
      .where(
        inArray(
          memoryIndex.id,
          free.map((r) => r.id),
        ),
      )
      .returning();
  });
}

/** A claimed row's outcome, written only while it still carries `claim`; the claim goes. */
function settle(
  db: Database,
  id: string,
  claim: string,
  set: PgUpdateSetSource<typeof memoryIndex>,
) {
  return db
    .update(memoryIndex)
    .set({ ...set, claim: null, claimedAt: null, updatedAt: sql`now()` })
    .where(claimed(id, claim));
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
