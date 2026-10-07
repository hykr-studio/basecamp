import type { Approval, AuthorizeResult, Principal } from '@app/contracts';
import { approvals, type Database, writeAudit } from '@app/db';
import { subjectOf } from '@app/policy';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, eq } from 'drizzle-orm';
import { CORE_OPTIONS, type CoreOptions, type Tx } from '../tokens.js';
import { auditCtx, runWrite, type WriteCtx, type WriteOp } from './pipeline.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Every operation that can be parked registers how to rebuild itself from what was
 * stored: entity CRUD by name and args ({ id }), commands by name.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations
type OpFactory = (args: Record<string, unknown> | null) => WriteOp<any, any, any>;
const registry = new Map<string, OpFactory>();

export function registerOp(name: string, factory: OpFactory) {
  registry.set(name, factory);
}

type ApprovalRow = typeof approvals.$inferSelect;
type Stored = {
  op: string;
  args: Record<string, unknown> | null;
  input: unknown;
  principal: Principal;
};

export function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    action: row.action,
    rule: row.rule,
    reason: row.reason,
    status: row.status as Approval['status'],
    summary: row.summary ?? (row.payload as { summary?: string } | null)?.summary ?? null,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    input: (row.payload as { input?: unknown } | null)?.input ?? null,
    requestedBy: row.requestedBy,
    expiresAt: row.expiresAt.toISOString(),
    failureReason: row.failureReason,
  };
}

let ttlMs = DEFAULT_TTL_MS;
export function setApprovalTtl(ms: number) {
  ttlMs = ms;
}

/** Store the operation, its validated input and who asked; the owner decides later. */
export async function parkForApproval<I, L>(
  tx: Tx,
  ctx: WriteCtx,
  // biome-ignore lint/suspicious/noExplicitAny: any operation can be parked
  op: WriteOp<I, L, any>,
  input: I,
  loaded: L,
  result: AuthorizeResult,
): Promise<Approval> {
  const p = ctx.principal;
  const ownerId = subjectOf(p);
  if (!ownerId) throw new ConflictException('Nobody to ask for approval');
  const stored: Stored = { op: op.name, args: op.args ?? null, input, principal: p };
  const [row] = await tx
    .insert(approvals)
    .values({
      ownerId,
      action: op.name,
      rule: result.rule,
      reason: result.reason,
      resourceType: op.resourceType,
      resourceId: op.resourceId(input, loaded),
      summary: op.summarize(input, loaded),
      payload: stored,
      requestedBy: p.actor.kind,
      runId: p.runId ?? null,
      status: 'pending',
      expiresAt: new Date(Date.now() + ttlMs),
    })
    .returning();
  return toApproval(row);
}

/** Lists and decides approvals. Approving replays the parked operation through runWrite. */
@Injectable()
export class ApprovalService {
  private readonly db: Database;
  constructor(
    @Inject(CORE_OPTIONS) options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
  ) {
    this.db = options.db;
  }

  async get(p: Principal, id: string): Promise<Approval> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.ownerId, p.actor.id)));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such approval' });
    return toApproval(row);
  }

  async pending(p: Principal): Promise<Approval[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.ownerId, p.actor.id), eq(approvals.status, 'pending')))
      .orderBy(asc(approvals.createdAt));
    return rows.map(toApproval);
  }

  async decide(p: Principal, id: string, approve: boolean, requestId: string): Promise<Approval> {
    // Scoped to the owner: someone else's approval id is a 404, not a 403.
    const [found] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.ownerId, p.actor.id)));
    if (!found) throw new NotFoundException({ error: 'not_found', message: 'No such approval' });
    if (found.status !== 'pending') {
      throw new ConflictException({ error: 'already_decided', status: found.status });
    }
    const ctx: WriteCtx = { principal: p, requestId };
    const decision = (status: string) => ({
      rule: 'owner_decides',
      reason: `Owner ${status} the request`,
    });

    const close = async (
      tx: Tx | Database,
      status: 'rejected' | 'expired' | 'failed',
      failureReason?: string,
    ) => {
      const [row] = await tx
        .update(approvals)
        .set({
          status,
          decidedAt: new Date(),
          decidedBy: p.actor.id,
          failureReason: failureReason ?? null,
        })
        .where(eq(approvals.id, found.id))
        .returning();
      await writeAudit(tx, {
        ...auditCtx(p, decision(status), ctx),
        action: `approval.${status}`,
        resourceType: 'approval',
        resourceId: found.id,
        before: found,
        after: row,
        ...(failureReason ? { reason: failureReason } : {}),
      });
      return toApproval(row);
    };

    if (!approve) return this.db.transaction((tx) => close(tx, 'rejected'));
    if (found.expiresAt <= new Date()) return this.db.transaction((tx) => close(tx, 'expired'));

    const stored = found.payload as Stored | null;
    const factory = stored?.op ? registry.get(stored.op) : undefined;
    if (!stored || !factory) {
      return this.db.transaction((tx) =>
        close(tx, 'failed', 'This request can no longer be replayed'),
      );
    }

    try {
      const { approval, events } = await this.db.transaction(async (tx) => {
        // Lock it: two approvals of the same request must not both replay.
        const [current] = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, found.id))
          .for('update');
        if (current?.status !== 'pending')
          throw new ConflictException({ error: 'already_decided' });

        // Replay as the original requester, marked approved by this person, under this request.
        const replayCtx: WriteCtx = {
          principal: { ...stored.principal, approvedBy: p.actor.id },
          requestId,
          idempotencyKey: `approval:${found.id}`,
          tx,
        };
        const out = await runWrite(this.db, replayCtx, factory(stored.args), stored.input);
        if (out.result.status !== 'done')
          throw new ConflictException('The replay was parked again');

        const [row] = await tx
          .update(approvals)
          .set({ status: 'approved', decidedAt: new Date(), decidedBy: p.actor.id })
          .where(eq(approvals.id, found.id))
          .returning();
        await writeAudit(tx, {
          ...auditCtx(p, decision('approved'), ctx),
          action: 'approval.approved',
          resourceType: 'approval',
          resourceId: found.id,
          before: current,
          after: row,
        });
        return { approval: toApproval(row), events: out.events };
      });
      for (const event of events) this.events.publish(event);
      return approval;
    } catch (e) {
      // Refused or missing on replay (the meeting was closed meanwhile): record why.
      if (e instanceof HttpException && [403, 404, 409].includes(e.getStatus())) {
        const body = e.getResponse() as { reason?: string; message?: string };
        if (e.getStatus() === 409 && (body as { error?: string }).error === 'already_decided')
          throw e;
        return this.db.transaction((tx) =>
          close(tx, 'failed', body?.reason ?? body?.message ?? e.message),
        );
      }
      throw e;
    }
  }
}
