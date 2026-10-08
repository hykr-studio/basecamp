import { createHash } from 'node:crypto';
import type { Approval, AuthorizeResult, Principal, WriteResult } from '@app/contracts';
import { type WriteCtx as AuditCtx, type Database, idempotencyKeys, writeAudit } from '@app/db';
import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { RuleDenied } from '../authorize.js';
import type { Tx } from '../tokens.js';
import { parkForApproval } from './approvals.js';

/** Who is writing and how to recognise a repeat. Carried by every command. */
export interface WriteCtx {
  principal: Principal;
  requestId: string;
  idempotencyKey?: string;
  /** Run inside this transaction instead of opening one (an approval replay). */
  tx?: Tx;
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
  load?(tx: Tx, p: Principal, input: I): Promise<L>;
  authorize(p: Principal, loaded: L, input: I): AuthorizeResult;
  summarize(input: I, loaded: L): string;
  run(a: { tx: Tx; principal: Principal; input: I; loaded: L }): Promise<RunResult<V>>;
  /** The value as it leaves the API (rows → contract shapes). */
  present(value: V): unknown;
}

export interface WriteOutcome {
  result: WriteResult;
  events: object[];
}

export function auditCtx(
  p: Principal,
  result: Pick<AuthorizeResult, 'rule' | 'reason'>,
  ctx: WriteCtx,
): AuditCtx {
  return {
    actorKind: p.actor.kind,
    actorId: p.actor.id,
    actingFor: p.actingFor?.userId ?? null,
    runId: p.runId ?? null,
    agentVersion: p.agentVersion ?? null,
    channel: p.channel ?? null,
    requestId: ctx.requestId,
    approvedBy: p.approvedBy ?? null,
    rule: result.rule,
    reason: result.reason,
  };
}

/** Keys are per caller: the agent acting for Ana never shares a key with Ana herself. */
const principalKey = (p: Principal) =>
  [p.actor.kind, p.actor.id, p.actingFor?.userId ?? ''].join(':');

const verbs = { created: 'create', updated: 'update', deleted: 'delete' } as const;

/**
 * The write path every command takes:
 * validate → idempotency → load → authorize → (park | run) → audit → events after commit.
 * Change how audit or approvals work here, once.
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

  // 2. Idempotency: a repeat of (key, principal) returns the stored result.
  const requestHash = createHash('sha256')
    .update(JSON.stringify([op.name, op.args ?? null, input]))
    .digest('hex');
  const key = ctx.idempotencyKey;
  if (key) {
    const [hit] = await (ctx.tx ?? db)
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.principalId, principalKey(p))));
    if (hit) {
      if (hit.requestHash !== requestHash) {
        throw new ConflictException('idempotency-key was already used for a different request');
      }
      return { result: hit.response as WriteResult, events: [] };
    }
  }

  let refusal: { result: AuthorizeResult; resourceId: string | null } | undefined;
  const work = async (tx: Tx): Promise<WriteOutcome> => {
    // 3. Load what the rules need, scoped to the principal (404 if not theirs).
    const loaded = (op.load ? await op.load(tx, p, input) : undefined) as L;
    const resourceId = op.resourceId(input, loaded);

    // 4. Authorize. A person's approval turns needs_approval into allow for the replay.
    let decision = op.authorize(p, loaded, input);
    if (decision.decision === 'needs_approval' && p.approvedBy) {
      decision = {
        decision: 'allow',
        rule: `approved:${decision.rule}`,
        reason: `Approved by the owner: ${decision.reason}`,
      };
    }
    if (decision.decision === 'deny') {
      refusal = { result: decision, resourceId };
      throw new RuleDenied(decision);
    }

    let result: WriteResult;
    let events: object[] = [];
    if (decision.decision === 'needs_approval') {
      const approval: Approval = await parkForApproval(tx, ctx, op, input, loaded, decision);
      await writeAudit(tx, {
        ...auditCtx(p, decision, ctx),
        action: op.name,
        resourceType: op.resourceType,
        resourceId,
        outcome: 'needs_approval',
        after: { approvalId: approval.id, summary: approval.summary },
      });
      result = { status: 'needs_approval', approval };
    } else {
      // 5. Do the work. The handler sees tx, principal and loaded rows; never the raw request.
      const out = await op.run({ tx, principal: p, input, loaded });

      // 6. Audit in the same transaction: one row per entity touched, plus one for a command.
      for (const t of out.touched) {
        await writeAudit(tx, {
          ...auditCtx(p, decision, ctx),
          action: `${t.type}.${verbs[t.change]}`,
          resourceType: t.type,
          resourceId: t.id,
          before: t.before ?? null,
          after: t.after ?? null,
        });
      }
      if (op.kind === 'command') {
        await writeAudit(tx, {
          ...auditCtx(p, decision, ctx),
          action: op.name,
          resourceType: op.resourceType,
          resourceId,
          after: { touched: out.touched.map(({ type, id, change }) => ({ type, id, change })) },
        });
      }
      result = { status: 'done', value: op.present(out.value) };
      // 7. Events are collected here and published by the caller after commit.
      events = out.events ?? [];
    }

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
    throw e;
  }
}
