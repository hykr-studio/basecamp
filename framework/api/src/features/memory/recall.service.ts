import {
  type MemoryAbout,
  type MemoryPolicy,
  memoryTraitOf,
  type Principal,
  type RecallItem,
  type RecallKind,
  type RecallResult,
  subjectKey,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  CORE_OPTIONS,
  type Conn,
  type CoreOptions,
  entityDef,
  TenantConfigService,
} from '@hykr/core';
import { threadMessages, threads } from '@hykr/db';
import { subjectOf } from '@hykr/policy';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { embed } from 'ai';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { TurnGate, TurnInfo, TurnOutcome } from '../../hooks.js';
import { ModelPolicyService, ModelRefused } from '../models/model-policy.service.js';
import { type Candidate, keepMessage, nearest, recentMessages } from './store.js';

const log = new Logger('Memory');
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The messages of the current thread the model already reads as history (ChatService keeps the
 * last 12), so recall does not repeat them.
 */
const IN_HISTORY = 12;
/** Longest text per recalled memory: in a turn's context, and in the recall API. */
const CONTEXT_CHARS = 400;
const API_CHARS = 2000;
/** Vectors made in a turn's `before`, kept for its `after` (or dropped after this long). */
const KEEP_MS = 10 * 60_000;

const cut = (text: string, n: number) =>
  text.length > n
    ? `${Array.from(text)
        .slice(0, n - 1)
        .join('')}…`
    : text;

/** `meeting:1f0c…` → { type, id }. */
export function parseAbout(about: string | undefined): MemoryAbout | undefined {
  if (!about) return undefined;
  const at = about.indexOf(':');
  return { type: about.slice(0, at), id: about.slice(at + 1) };
}

/** One recalled memory as a line of a turn's context: where it comes from, then its words. */
export function contextLine(item: RecallItem, label?: string): string {
  if (item.kind === 'message')
    return `Recalled, what the person said${item.at ? ` on ${item.at.slice(0, 10)}` : ''}: ${cut(item.text, CONTEXT_CHARS)}`;
  const about = item.about ? ` about ${item.about.type} ${item.about.id}` : '';
  return `Recalled ${label ?? item.type} ${item.id}${about}: ${cut(item.text, CONTEXT_CHARS)}`;
}

export interface RecallRequest {
  query: string;
  /** Only memory of this record (checked first: one the reader cannot read is a 404). */
  about?: MemoryAbout;
  limit?: number;
  kinds?: readonly RecallKind[];
  /** A thread whose latest messages are already in the model's history. */
  thread?: string;
  /** The vector of `query`, when the caller made it already. */
  embedded?: { model: string; vector: number[] };
  minScore?: number;
}

type Embedded = { model: string; vector: number[] };

let service: RecallService | undefined;

/**
 * The memory feature's turn hook: recall before each chat turn, keep the person's words after it.
 * Its work is the RecallService's, which registers itself when the feature starts; without one,
 * the hook has no opinion.
 */
export const RecallHook = {
  name: 'memory.recall',
  before: (turn: TurnInfo): Promise<TurnGate | null> =>
    service ? service.beforeTurn(turn) : Promise.resolve(null),
  after: (turn: TurnInfo, outcome: TurnOutcome): Promise<void> =>
    service ? service.afterTurn(turn, outcome) : Promise.resolve(),
};

/**
 * Semantic recall. A question is embedded with the business's embedding model (its model
 * policy), the nearest memories are found in the index, and each is loaded again as the reader:
 * a record through its entity's scoped repository and projection (and the record it is about,
 * the same way), a message only while it is still one of the person's own. What fails is dropped,
 * so recall never shows what the reader may not read now.
 */
@Injectable()
export class RecallService implements OnModuleInit, OnModuleDestroy {
  private readonly made = new Map<string, Embedded & { at: number }>();

  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    private readonly tenants: TenantConfigService,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {}

  onModuleInit() {
    service = this;
  }

  onModuleDestroy() {
    if (service === this) service = undefined;
  }

  private get db(): Conn {
    return this.core.db;
  }

  /** The business's memory settings; none (recall off) when they do not parse. */
  async policyOf(tenantId: string): Promise<MemoryPolicy | undefined> {
    try {
      return (await this.tenants.get(tenantId)).settings.memory;
    } catch (e) {
      log.warn(`The settings of business ${tenantId} do not parse: ${reason(e)}`);
      return undefined;
    }
  }

  /** The text's vector with the business's embedding model. Throws ModelRefused. */
  async embed(tenantId: string, text: string): Promise<Embedded> {
    const models = this.ref.get(ModelPolicyService, { strict: false });
    const { ref, model } = await models.embeddingFor(tenantId);
    const { embedding } = await embed({ model, value: text, maxRetries: 1 });
    return { model: ref, vector: embedding };
  }

  /**
   * The memories nearest to the question that this principal may read now, best first. Records
   * of entities with the `memory` trait (the business's memory among them) and, for a person, what
   * they said before. `model` is null when the business has no embedding model it may use.
   */
  async recall(p: Principal, req: RecallRequest): Promise<RecallResult> {
    const tenantId = p.tenantId;
    if (!tenantId) return { items: [], model: null };
    const policy = await this.policyOf(tenantId);
    let embedded = req.embedded;
    if (!embedded) {
      try {
        embedded = await this.embed(tenantId, req.query);
      } catch (e) {
        if (e instanceof ModelRefused) return { items: [], model: null };
        throw e;
      }
    }
    const limit = req.limit ?? policy?.limit ?? 5;
    const kinds = req.kinds ?? ['record', 'message'];
    const subject = subjectOf(p);
    const conversation = kinds.includes('message') && (policy?.conversation ?? true) && subject;
    const exclude = req.thread ? await recentMessages(this.db, req.thread, IN_HISTORY) : [];
    const candidates = await nearest(this.db, {
      tenantId,
      model: embedded.model,
      vector: embedded.vector,
      minScore: req.minScore ?? policy?.minScore ?? 0.3,
      // More than asked: some will not survive the reader's checks.
      limit: Math.max(20, limit * 4),
      records: kinds.includes('record'),
      ...(req.about ? { about: req.about } : {}),
      ...(conversation ? { subject: subjectKey(subject) } : {}),
      exclude,
    });
    const items: RecallItem[] = [];
    for (const c of candidates) {
      if (items.length >= limit) break;
      const item =
        c.kind === 'message'
          ? await this.message(p, tenantId, c)
          : await this.record(p, c, req.about);
      if (item) items.push(item);
    }
    return { items, model: embedded.model };
  }

  /**
   * A record, as this principal may see it now: its entity still serves it with the trait and
   * lets the assistant read it, the reader's scope finds it, the text comes from the projected
   * record, and the record it is about is readable too.
   */
  private async record(
    p: Principal,
    c: Candidate,
    only?: MemoryAbout,
  ): Promise<RecallItem | undefined> {
    const def = readable(c.sourceType);
    const trait = def && memoryTraitOf(def.spec);
    if (!def || !trait) return undefined;
    const row = await def.repo.find(this.db, p, c.sourceId);
    if (!row) return undefined;
    const read = def.toRead(row, p) as Record<string, unknown>;
    const text = trait.text(read)?.trim();
    if (!text) return undefined;
    const about = trait.about?.(read) ?? undefined;
    if (only && (about?.type !== only.type || about.id !== only.id)) return undefined;
    if (about && !(await this.canRead(p, about))) return undefined;
    const at = typeof read.updatedAt === 'string' ? read.updatedAt : read.createdAt;
    return {
      kind: 'record',
      type: def.name,
      id: c.sourceId,
      ...(about ? { about: { type: about.type, id: about.id } } : {}),
      text: cut(text, API_CHARS),
      score: round(c.score),
      ...(typeof at === 'string' ? { at } : {}),
    };
  }

  /** Something the person said: still in one of their own threads, in this business. */
  private async message(
    p: Principal,
    tenantId: string,
    c: Candidate,
  ): Promise<RecallItem | undefined> {
    const subject = subjectOf(p);
    if (!subject || !c.messageId) return undefined;
    const [m] = await this.db
      .select({ text: threadMessages.text, at: threadMessages.createdAt })
      .from(threadMessages)
      .innerJoin(threads, eq(threads.id, threadMessages.threadId))
      .where(
        and(
          eq(threadMessages.id, c.messageId),
          eq(threadMessages.role, 'user'),
          eq(threads.tenantId, tenantId),
          subject.kind === 'user'
            ? and(eq(threads.ownerId, subject.userId), isNull(threads.contactId))
            : eq(threads.contactId, subject.contactId),
        ),
      )
      .limit(1);
    if (!m?.text.trim()) return undefined;
    return {
      kind: 'message',
      type: 'message',
      id: c.messageId,
      text: cut(m.text.trim(), API_CHARS),
      score: round(c.score),
      at: m.at.toISOString(),
    };
  }

  /** Whether this principal may read this record (its entity lets the assistant read it too). */
  async canRead(p: Principal, about: MemoryAbout): Promise<boolean> {
    const def = readable(about.type);
    if (!def) return false;
    return Boolean(await def.repo.find(this.db, p, about.id));
  }

  /* ── The turn hook ───────────────────────────────────────────────────────── */

  /**
   * Before a chat turn: what the business and the person remember about the message, as context
   * lines (data, not instructions). Never for a draft (it goes to a customer). Recall only adds:
   * when it cannot run (off, no embedding model, an error), the turn runs without it.
   */
  async beforeTurn(turn: TurnInfo): Promise<TurnGate | null> {
    this.sweep();
    const p = turn.principal;
    if (turn.kind !== 'chat' || !p.tenantId || !turn.message.trim()) return null;
    const policy = await this.policyOf(p.tenantId);
    if (!policy?.recall || policy.limit === 0) return null;
    try {
      const embedded = await this.embed(p.tenantId, turn.message);
      if (policy.conversation && turn.threadId)
        this.made.set(turn.runId, { ...embedded, at: Date.now() });
      const { items } = await this.recall(p, {
        query: turn.message,
        embedded,
        limit: policy.limit,
        minScore: policy.minScore,
        kinds: policy.conversation ? ['record', 'message'] : ['record'],
        ...(turn.threadId ? { thread: turn.threadId } : {}),
      });
      if (!items.length) return null;
      return {
        context: items.map((item) => contextLine(item, entityDef(item.type)?.spec.label)),
      };
    } catch (e) {
      if (!(e instanceof ModelRefused)) log.warn(`run=${turn.runId} recall failed: ${reason(e)}`);
      return null;
    }
  }

  /**
   * After it: the person's message joins their conversation memory, with the vector made for
   * recall (no second embedding). Only the person's own words, never the reply.
   */
  async afterTurn(turn: TurnInfo, _outcome: TurnOutcome): Promise<void> {
    const made = this.made.get(turn.runId);
    this.made.delete(turn.runId);
    const subject = subjectOf(turn.principal);
    if (!made || !turn.threadId || !turn.principal.tenantId || !subject) return;
    const [saved] = await this.db
      .select({ id: threadMessages.id })
      .from(threadMessages)
      .where(
        and(
          eq(threadMessages.threadId, turn.threadId),
          eq(threadMessages.role, 'user'),
          eq(threadMessages.text, turn.message),
        ),
      )
      .orderBy(desc(threadMessages.seq))
      .limit(1);
    if (!saved) return;
    await keepMessage(this.db, {
      tenantId: turn.principal.tenantId,
      messageId: saved.id,
      subject: subjectKey(subject),
      model: made.model,
      vector: made.vector,
    });
  }

  /** Vectors whose turn never finished. */
  private sweep() {
    const old = Date.now() - KEEP_MS;
    for (const [run, m] of this.made) if (m.at < old) this.made.delete(run);
  }
}

const round = (score: number) => Math.round(score * 1000) / 1000;

/** A served entity the assistant may read records of (its `get` is open to everyone). */
function readable(type: string): AnyEntityDef | undefined {
  const def = entityDef(type);
  return def && def.spec.expose.get === 'all' ? def : undefined;
}
