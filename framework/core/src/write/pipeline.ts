import { createHash } from 'node:crypto';
import {
  type Approval,
  type ApprovalRule,
  type AuthorizeResult,
  approverOf,
  type DecisionDetails,
  onBehalfOfKey,
  type Principal,
  rankOf,
  type TenantConfig,
  type WriteResult,
} from '@hykr/contracts';
import {
  type WriteCtx as AuditCtx,
  type Database,
  idempotencyKeys,
  writeAudit,
  writeAuditMany,
} from '@hykr/db';
import { subjectKeyOf, subjectOf } from '@hykr/policy';
import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { allow, RuleDenied } from '../authorize.js';
import { referenceRefusal } from '../entity/references.js';
import { writeHooks } from '../hooks.js';
import type { Tx } from '../tokens.js';
import { parkForApproval } from './approvals.js';
import { strongerDecision } from './decisions.js';
import { recordEvents } from './events.js';
import { applyLevels, settingsIn } from './levels.js';
import { openUndoWindow, undoWindowMs } from './undo.js';

/** Who is writing and how to recognise a repeat. Carried by every command. */
export interface WriteCtx {
  principal: Principal;
  requestId: string;
  idempotencyKey?: string;
  /**
   * What the caller sent, when the op's input also carries values the server made for this
   * request (a fresh id, a sealed secret, a token's hash). A repeat is then recognised by this
   * instead of the input, so the same body under the same key answers the first answer, and a
   * different body is a 409. Omitted: the input.
   */
  requestBody?: unknown;
  /**
   * The request's `If-Match`: the record version the caller based its write on (B12). Entity
   * updates and deletes check it against the row they load; nothing else takes one.
   */
  ifMatch?: string;
  /** Run inside this transaction instead of opening one (an approval replay). */
  tx?: Tx;
  /**
   * An approval replay: what the decider approved (the level and amount it parked with). A
   * replay that now needs more (a higher level, a larger amount) fails instead of running.
   */
  approved?: DecisionDetails;
}

/** One row a write changed: one audit row each. */
export interface Touched {
  type: string;
  id: string;
  change: 'created' | 'updated' | 'deleted';
  before?: unknown;
  after?: unknown;
}

export interface RunResult<V> {
  value: V;
  touched: Touched[];
  events?: object[];
}

/** Everything the write path needs to run one operation. Entity CRUD and commands both build these. */
export interface WriteOp<I, L, V> {
  /** As audited and as parked: todo.update, meeting.close. */
  name: string;
  kind: 'entity' | 'command';
  resourceType: string;
  resourceId(input: I, loaded: L): string | null;
  input: z.ZodType<I>;
  /** What a replay needs besides the input, e.g. { id } for an update. */
  args?: Record<string, unknown>;
  /** Who decides it when it is parked (the approval rule's object form). */
  approval?: ApprovalRule;
  load?(tx: Tx, p: Principal, input: I): Promise<L>;
  authorize(p: Principal, loaded: L, input: I): AuthorizeResult;
  summarize(input: I, loaded: L): string;
  run(a: { tx: Tx; principal: Principal; input: I; loaded: L }): Promise<RunResult<V>>;
  /** The value as it leaves the API for this principal (rows → contract shapes, projected). */
  present(value: V, p: Principal): unknown;
  /**
   * The framework's own operation (undoing a write): level rules skip it, and it opens no undo
   * window of its own.
   */
  system?: boolean;
}

export interface WriteOutcome {
  result: WriteResult;
  events: object[];
  /**
   * The stored answer to an earlier request with this key: nothing ran. Whatever a caller adds
   * to the answer after the write (a secret shown once, a retry now) it must not do again.
   */
  repeat?: true;
}

export function auditCtx(
  p: Principal,
  result: Pick<AuthorizeResult, 'rule' | 'reason'>,
  ctx: WriteCtx,
): AuditCtx {
  const subject = subjectOf(p);
  return {
    actorKind: p.actor.kind,
    actorId: p.actor.id,
    // A person's id as before (history reads it); a contact as "contact:<id>".
    actingFor:
      p.actor.kind === 'agent'
        ? subject?.kind === 'user'
          ? subject.userId
          : (subjectKeyOf(p) ?? null)
        : null,
    tenantId: p.tenantId ?? null,
    subjectKind: subject?.kind ?? null,
    runId: p.runId ?? null,
    agentVersion: p.agentVersion ?? null,
    channel: p.channel ?? null,
    requestId: ctx.requestId,
    approvedBy: p.approvedBy ?? null,
    // Through the platform: an operator's action, or an operator's support access.
    onBehalfOf: onBehalfOfKey(p.onBehalfOf),
    rule: result.rule,
    reason: result.reason,
  };
}

/**
 * Does a replay now need more than was approved: a higher level, or a larger amount (another
 * currency, or an amount where none was approved, counts as larger)?
 */
function raisedSince(asked: DecisionDetails, now: AuthorizeResult): boolean {
  if (rankOf(now.level) > rankOf(asked.level)) return true;
  if (!now.amount) return false;
  if (!asked.amount || asked.amount.currency !== now.amount.currency) return true;
  return now.amount.minor > asked.amount.minor;
}

/**
 * Keys are per caller: the agent acting for Ana never shares a key with Ana herself, and one
 * operator's action (a system job on their behalf) never shares a key with another's.
 */
const principalKey = (p: Principal) =>
  [
    p.actor.kind,
    p.actor.id,
    p.tenantId ?? '',
    subjectKeyOf(p) ?? '',
    ...(p.onBehalfOf ? [onBehalfOfKey(p.onBehalfOf)] : []),
  ].join(':');

const verbs = { created: 'create', updated: 'update', deleted: 'delete' } as const;

/** What a repeat is recognised by: the op, its arguments and what was asked. */
const hashOf = (op: { name: string; args?: unknown }, request: unknown) =>
  createHash('sha256')
    .update(JSON.stringify([op.name, op.args ?? null, request]))
    .digest('hex');

/** The stored answer for (key, principal), if any; another request under the key is a 409. */
async function stored(
  conn: Database | Tx,
  p: Principal,
  key: string,
  requestHash: string,
): Promise<WriteOutcome | undefined> {
  const [hit] = await conn
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.principalId, principalKey(p))));
  if (!hit) return undefined;
  if (hit.requestHash !== requestHash)
    throw new ConflictException('idempotency-key was already used for a different request');
  return { result: hit.response as WriteResult, events: [], repeat: true };
}

/**
 * Before any work a route does ahead of its write (exchanging a one-time code, minting a
 * secret): the stored outcome when this request repeats an earlier one with the same key, or
 * undefined. A key used for a different request is a 409. `request` is what `runWrite` will be
 * given as `requestBody` (or as its input).
 */
export async function findRepeat(
  db: Database | Tx,
  ctx: Pick<WriteCtx, 'principal' | 'idempotencyKey'>,
  op: { name: string; args?: unknown },
  request: unknown,
): Promise<WriteOutcome | undefined> {
  if (!ctx.idempotencyKey) return undefined;
  return stored(db, ctx.principal, ctx.idempotencyKey, hashOf(op, request));
}

/**
 * For a write that does not go through `runWrite` (a file's upload, a job's cancel): keep its
 * answer under the caller's key, so `findRepeat` answers it again. Nothing secret belongs in
 * `response`: it is kept for IDEMPOTENCY_KEEP_DAYS.
 */
export async function saveReply(
  db: Database | Tx,
  ctx: Pick<WriteCtx, 'principal' | 'idempotencyKey'>,
  op: { name: string; args?: unknown },
  request: unknown,
  response: unknown,
): Promise<void> {
  if (!ctx.idempotencyKey) return;
  await db
    .insert(idempotencyKeys)
    .values({
      key: ctx.idempotencyKey,
      principalId: principalKey(ctx.principal),
      requestHash: hashOf(op, request),
      response,
    })
    .onConflictDoNothing({ target: [idempotencyKeys.key, idempotencyKeys.principalId] });
}

/**
 * For a route that honours idempotency-key without `runWrite` (a back-office reply, a file's
 * upload or discard, a job's cancel, a calendar sign-in's completion): one request at a time per
 * (caller, key). A second request with the key, sent while the first still runs (a client that
 * timed out and tried again), waits for it to finish, then finds its reply: `work` looks for the
 * repeat (`findRepeat`) on the connection it is given, first. `work` runs in a transaction that
 * holds the lock until it ends, so save the reply on that connection (`saveReply`). The lock is
 * not `runWrite`'s own, so `work` may call `runWrite` with the same key. Without a key, `work`
 * runs at once, on `db`, with no transaction.
 */
export async function oneAtATime<T>(
  db: Database,
  ctx: Pick<WriteCtx, 'principal' | 'idempotencyKey'>,
  work: (conn: Database | Tx) => Promise<T>,
): Promise<T> {
  const key = ctx.idempotencyKey;
  if (!key) return work(db);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`idempotency.route:${principalKey(ctx.principal)}:${key}`}, 0))`,
    );
    return work(tx);
  });
}

/**
 * The write path every command takes:
 * validate → idempotency → load → authorize (the op, then write hooks) → (park | run) → audit
 * → stored events → write hooks' afterRun, all in one transaction; in-process events are
 * published by the caller after commit. Change how audit or approvals work here, once.
 */
export async function runWrite<I, L, V>(
  db: Database,
  ctx: WriteCtx,
  op: WriteOp<I, L, V>,
  rawInput: unknown,
): Promise<WriteOutcome> {
  const p = ctx.principal;
  // 1. Validate again: commands also arrive from the agent and from approval replays.
  const input = op.input.parse(rawInput);

  // 2. Idempotency: a repeat of (key, principal) returns the stored result. It is recognised
  // by what the caller sent when the input also holds what the server made for this request.
  const requestHash = hashOf(op, ctx.requestBody !== undefined ? ctx.requestBody : input);
  const key = ctx.idempotencyKey;
  const storedReply = async (conn: Database | Tx): Promise<WriteOutcome | undefined> =>
    key ? stored(conn, p, key, requestHash) : undefined;
  // A repeat answers at once, without a transaction.
  const repeat = await storedReply(ctx.tx ?? db);
  if (repeat) return repeat;

  let refusal: { result: AuthorizeResult; resourceId: string | null } | undefined;
  const work = async (tx: Tx): Promise<WriteOutcome> => {
    // Two requests with one key at the same moment: the second waits here for the first to
    // commit, then answers with its stored reply (B12). One write, one audit row.
    if (key) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`idempotency:${principalKey(p)}:${key}`}, 0))`,
      );
      const first = await storedReply(tx);
      if (first) return first;
    }
    // 3. Load what the rules need, scoped to the principal (404 if not theirs).
    const loaded = (op.load ? await op.load(tx, p, input) : undefined) as L;
    const resourceId = op.resourceId(input, loaded);

    // 4. Authorize: the operation's decision, tightened by every write hook (never loosened).
    let decision = op.authorize(p, loaded, input);
    for (const hook of writeHooks.all()) {
      if (!hook.decide) continue;
      const tighter = hook.decide({ ctx, op, input, loaded, decision });
      decision = strongerDecision(decision, tighter) ?? decision;
    }
    // Then the application's approval levels: its level rules on the input and the row, and
    // the level's policy in this business (does it wait, how long can it be undone).
    let settings: TenantConfig | undefined;
    if (!op.system)
      decision = await applyLevels({
        decision,
        p,
        op,
        input,
        loaded,
        settings: async () => (settings ??= await settingsIn(tx, p.tenantId)),
      });
    // A park names the level its approval rule declares, when nothing else named one.
    const ruleLevel = approverOf(op.approval).level;
    if (decision.decision === 'needs_approval' && decision.level === undefined && ruleLevel)
      decision = { ...decision, level: ruleLevel };
    // A person's approval turns needs_approval into allow for the replay, keeping what is at
    // stake (the level, the amount), unless it now needs more than was approved. The approval
    // ends the undo window: the replay opens none.
    if (decision.decision === 'needs_approval' && p.approvedBy) {
      if (ctx.approved && raisedSince(ctx.approved, decision))
        throw new ConflictException({
          error: 'changed_since_asked',
          reason: 'It needs more approval now than when it was asked: ask again',
        });
      const { undoMs: _ended, ...kept } = decision;
      decision = allow(
        `approved:${decision.rule}`,
        `Approved by the owner: ${decision.reason}`,
        kept,
      );
    }
    if (decision.decision === 'deny') {
      refusal = { result: decision, resourceId };
      throw new RuleDenied(decision);
    }

    let result: WriteResult;
    let events: object[] = [];
    let value: unknown;
    let touched: Touched[] = [];
    let undoMs = 0;
    if (decision.decision === 'needs_approval') {
      const parked = await parkForApproval(tx, ctx, op, input, loaded, decision, settings);
      const approval: Approval = parked.approval;
      events = [parked.event];
      await writeAudit(tx, {
        ...auditCtx(p, decision, ctx),
        action: op.name,
        resourceType: op.resourceType,
        resourceId,
        outcome: 'needs_approval',
        after: {
          approvalId: approval.id,
          summary: approval.summary,
          ...(decision.level !== undefined ? { level: decision.level } : {}),
        },
      });
      result = { status: 'needs_approval', approval };
    } else {
      // 5. Do the work. The handler sees tx, principal and loaded rows; never the raw request.
      const out = await op.run({ tx, principal: p, input, loaded });

      // 6. Audit in the same transaction: one row per entity touched, plus one for a command,
      // inserted together (a 200-line write is one statement, not 200).
      const by = auditCtx(p, decision, ctx);
      await writeAuditMany(tx, [
        ...out.touched.map((t) => ({
          ...by,
          action: `${t.type}.${verbs[t.change]}`,
          resourceType: t.type,
          resourceId: t.id,
          before: t.before ?? null,
          after: t.after ?? null,
        })),
        ...(op.kind === 'command'
          ? [
              {
                ...by,
                action: op.name,
                resourceType: op.resourceType,
                resourceId,
                after: {
                  touched: out.touched.map(({ type, id, change }) => ({ type, id, change })),
                },
              },
            ]
          : []),
      ]);
      result = { status: 'done', value: op.present(out.value, p) };
      value = out.value;
      touched = out.touched;
      // 7. Events: stored here, in the transaction; published by the caller after commit.
      events = out.events ?? [];
      undoMs = undoWindowMs(p, op, decision, touched);
    }

    // 8. The durable outbox: each named event. A write that can be undone is held back for its
    // undo window (undoing it withdraws them); a park's approval.requested goes at once.
    const stored = await recordEvents(tx, {
      principal: p,
      requestId: ctx.requestId,
      events,
      delayMs: undoMs || undefined,
    });
    if (undoMs && result.status === 'done') {
      const undo = await openUndoWindow(tx, {
        p,
        op,
        resourceId,
        touched,
        eventIds: stored.map((e) => e.id),
        undoMs,
        requestId: ctx.requestId,
      });
      result = { ...result, undo };
    }

    // 9. Write hooks, still in the transaction: throwing rolls the whole write back.
    for (const hook of writeHooks.all())
      await hook.afterRun?.({ ctx, op, input, loaded, tx, value, touched, result });

    if (key) {
      await tx
        .insert(idempotencyKeys)
        .values({ key, principalId: principalKey(p), requestHash, response: result })
        .onConflictDoNothing({ target: [idempotencyKeys.key, idempotencyKeys.principalId] });
    }
    return { result, events };
  };

  try {
    return ctx.tx ? await work(ctx.tx) : await db.transaction(work);
  } catch (e) {
    if (e instanceof RuleDenied) {
      // The transaction rolled back; the refusal is evidence, so record it on its own.
      const result = e.result;
      await writeAudit(db, {
        ...auditCtx(p, result, ctx),
        action: op.name,
        resourceType: op.resourceType,
        resourceId: refusal?.resourceId ?? null,
        outcome: 'denied',
      });
      throw new ForbiddenException({
        error: 'forbidden',
        rule: result.rule,
        reason: result.reason,
      });
    }
    if (e instanceof HttpException) throw e;
    // A key the database refused in the write's own code (a command's insert, a child's bulk
    // insert): a 404 without the database's detail, never a 500 that tells an id exists (V2).
    throw referenceRefusal(e, 'write');
  }
}
