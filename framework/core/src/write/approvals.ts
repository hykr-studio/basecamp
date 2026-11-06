import {
  type Approval,
  type ApprovalRule,
  type Assurance,
  type AuthorizeResult,
  approverOf,
  atLeast,
  type DecisionDetails,
  type Principal,
} from '@hykr/contracts';
import { approvals, type Database, writeAudit } from '@hykr/db';
import { subjectOf, userIdOf } from '@hykr/policy';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, arrayOverlaps, asc, eq, or, type SQL } from 'drizzle-orm';
import type { NamedEvent } from '../entity/cqrs-classes.js';
import { entityDef } from '../entity/registry.js';
import { projectRead } from '../hooks.js';
import { PrincipalResolver } from '../http/resolver.js';
import { CORE_OPTIONS, type CoreOptions, type Tx } from '../tokens.js';
import { recordEvents } from './events.js';
import { auditCtx, runWrite, type WriteCtx, type WriteOp } from './pipeline.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type ApprovalRow = typeof approvals.$inferSelect;

/**
 * approval.requested (parked) and approval.decided (approved, rejected, expired, failed):
 * NamedEvents, so notifications can ask the deciders and tell a customer the outcome. The row
 * leaves out the stored operation (its input and principal stay in the database).
 */
export class ApprovalEvent implements NamedEvent {
  readonly row: Omit<ApprovalRow, 'payload'>;
  readonly resourceType = 'approval';
  get resourceId() {
    return this.row.id;
  }
  constructor(
    readonly eventName: 'approval.requested' | 'approval.decided',
    row: ApprovalRow,
  ) {
    const { payload: _payload, ...rest } = row;
    this.row = rest;
  }
}

/**
 * Every operation that can be parked registers how to rebuild itself from what was
 * stored: entity CRUD by name and args ({ id }), commands by name.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations
type OpFactory = (args: Record<string, unknown> | null) => WriteOp<any, any, any>;
const registry = new Map<string, { factory: OpFactory; owner?: object }>();

/**
 * Register how to replay a parked operation. A name belongs to one definition: another entity
 * or command with the same name would replay the wrong code, so it throws at startup instead.
 * `owner` is that definition; registering it again (a module's forRoot called twice) is a no-op.
 */
export function registerOp(name: string, factory: OpFactory, owner?: object) {
  const taken = registry.get(name);
  if (taken && owner !== undefined && taken.owner === owner) return;
  if (taken) throw new Error(`The operation "${name}" is registered twice`);
  registry.set(name, { factory, owner });
}

type Stored = {
  op: string;
  args: Record<string, unknown> | null;
  input: unknown;
  principal: Principal;
  /** What the decision that parked it said is at stake. */
  decision?: DecisionDetails;
};

/** An approval row as stored: every field, for the server's own use. */
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
    decidedAt: row.decidedAt?.toISOString() ?? null,
    tier: (row.payload as Stored | null)?.decision?.tier ?? null,
    amount: (row.payload as Stored | null)?.decision?.amount ?? null,
  };
}

/**
 * An approval as one person may see it. The parked input of an entity's write is projected as
 * that entity's record (a hidden field stays hidden on the card), then the whole approval goes
 * through the read projectors as 'approval'.
 */
export function approvalFor(row: ApprovalRow, p: Principal): Approval {
  const approval = toApproval(row);
  const def = entityDef(row.resourceType);
  const input = approval.input;
  const entityWrite = def && row.action.startsWith(`${def.name}.`);
  const seen =
    entityWrite && input && typeof input === 'object' && !Array.isArray(input)
      ? def.project(input as Record<string, unknown>, p)
      : input;
  return projectRead('approval', { ...approval, input: seen }, p) as Approval;
}

let ttlMs = DEFAULT_TTL_MS;
export function setApprovalTtl(ms: number) {
  ttlMs = ms;
}

/**
 * Who decides a parked action. The person it is for decides their own assistant's requests; a
 * customer's (or a contact's) request goes to the business: the roles the rule names, or owner
 * and ops.
 */
function decidersFor(p: Principal, rule: ApprovalRule | undefined) {
  const { by, channels, minAssurance } = approverOf(rule);
  const self = userIdOf(p);
  const customer = (p.roles ?? []).length > 0 && (p.roles ?? []).every((r) => r === 'customer');
  const toSelf = by === 'self' || (by === undefined && self && !customer);
  return {
    approverUserId: toSelf ? self : null,
    approverRoles: toSelf ? [] : [...(Array.isArray(by) ? by : ['owner', 'ops'])],
    approverChannels: channels ? [...channels] : null,
    minAssurance: minAssurance ?? null,
  };
}

/**
 * Who decides, when the decision names them (an approver per amount band): its person or roles
 * replace the rule's deciders, and its channels and assurance replace the rule's.
 */
function withApprover(
  deciders: ReturnType<typeof decidersFor>,
  approver: AuthorizeResult['approver'],
): ReturnType<typeof decidersFor> {
  if (!approver) return deciders;
  const named = approver.userId !== undefined || approver.roles !== undefined;
  return {
    approverUserId: named ? (approver.userId ?? null) : deciders.approverUserId,
    approverRoles: named ? [...(approver.roles ?? [])] : deciders.approverRoles,
    approverChannels: approver.channels ? [...approver.channels] : deciders.approverChannels,
    minAssurance: approver.minAssurance ?? deciders.minAssurance,
  };
}

const detailsOf = (r: AuthorizeResult): DecisionDetails | undefined => {
  const out: DecisionDetails = {};
  if (r.tier !== undefined) out.tier = r.tier;
  if (r.approver !== undefined) out.approver = r.approver;
  if (r.amount !== undefined) out.amount = r.amount;
  if (r.undoMs !== undefined) out.undoMs = r.undoMs;
  return Object.keys(out).length ? out : undefined;
};

/** Store the operation, its validated input and who asked; whoever may decide does, later. */
export async function parkForApproval<I, L>(
  tx: Tx,
  ctx: WriteCtx,
  // biome-ignore lint/suspicious/noExplicitAny: any operation can be parked
  op: WriteOp<I, L, any>,
  input: I,
  loaded: L,
  result: AuthorizeResult,
): Promise<{ approval: Approval; event: ApprovalEvent }> {
  const p = ctx.principal;
  const subject = subjectOf(p);
  if (!subject || !p.tenantId) throw new ConflictException('Nobody to ask for approval');
  const decision = detailsOf(result);
  const stored: Stored = {
    op: op.name,
    args: op.args ?? null,
    input,
    principal: p,
    ...(decision ? { decision } : {}),
  };
  const [row] = await tx
    .insert(approvals)
    .values({
      tenantId: p.tenantId,
      ownerId: subject.kind === 'user' ? subject.userId : null,
      requesterContactId: subject.kind === 'contact' ? subject.contactId : null,
      ...withApprover(decidersFor(p, op.approval), result.approver),
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
  return { approval: approvalFor(row, p), event: new ApprovalEvent('approval.requested', row) };
}

/**
 * The approvals this principal may decide, in its business: its own (it is the decider), or
 * any whose decider roles it holds. Everything else is a 404, never a hint it exists.
 */
function decidable(p: Principal): SQL {
  const self = userIdOf(p);
  const roles = (p.roles ?? []).filter((r) => r !== 'customer');
  const mine = [
    ...(self ? [eq(approvals.approverUserId, self)] : []),
    ...(roles.length ? [arrayOverlaps(approvals.approverRoles, roles)] : []),
  ];
  return and(
    eq(approvals.tenantId, p.tenantId ?? ''),
    mine.length ? or(...mine) : eq(approvals.id, ''),
  ) as SQL;
}

/** Lists and decides approvals. Approving replays the parked operation through runWrite. */
@Injectable()
export class ApprovalService {
  private readonly db: Database;
  constructor(
    @Inject(CORE_OPTIONS) options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    private readonly resolver: PrincipalResolver,
  ) {
    this.db = options.db;
  }

  async get(p: Principal, id: string): Promise<Approval> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), decidable(p)));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such approval' });
    return approvalFor(row, p);
  }

  async pending(p: Principal): Promise<Approval[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(and(decidable(p), eq(approvals.status, 'pending')))
      .orderBy(asc(approvals.createdAt));
    return rows.map((row) => approvalFor(row, p));
  }

  async decide(p: Principal, id: string, approve: boolean, requestId: string): Promise<Approval> {
    // Only what this principal may decide: someone else's approval id is a 404, not a 403.
    const [found] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), decidable(p)));
    if (!found) throw new NotFoundException({ error: 'not_found', message: 'No such approval' });
    if (found.status !== 'pending') {
      throw new ConflictException({ error: 'already_decided', status: found.status });
    }
    // Where, and how surely, it may be decided: some actions only in the app, signed in.
    const channel = p.channel ?? 'app';
    if (found.approverChannels && !found.approverChannels.includes(channel))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'decide_elsewhere',
        reason: `Approve this in the ${found.approverChannels.join(' or ')}`,
      });
    if (found.minAssurance && !atLeast(p.assurance, found.minAssurance as Assurance))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'needs_assurance',
        reason: 'Approve this in the app, signed in',
      });
    const ctx: WriteCtx = { principal: p, requestId };
    const deciderKey = userIdOf(p) ?? p.actor.id;
    const decision = (status: string) => ({
      rule: 'owner_decides',
      reason: `Owner ${status} the request`,
    });

    const close = async (
      tx: Tx,
      status: 'rejected' | 'expired' | 'failed',
      failureReason?: string,
    ) => {
      // Only while still pending: a decision made meanwhile (a double tap) is not overwritten.
      const [row] = await tx
        .update(approvals)
        .set({
          status,
          decidedAt: new Date(),
          decidedBy: deciderKey,
          failureReason: failureReason ?? null,
        })
        .where(
          status === 'failed'
            ? eq(approvals.id, found.id)
            : and(eq(approvals.id, found.id), eq(approvals.status, 'pending')),
        )
        .returning();
      if (!row) throw new ConflictException({ error: 'already_decided' });
      await writeAudit(tx, {
        ...auditCtx(p, decision(status), ctx),
        action: `approval.${status}`,
        resourceType: 'approval',
        resourceId: found.id,
        before: found,
        after: row,
        ...(failureReason ? { reason: failureReason } : {}),
      });
      await recordEvents(tx, {
        principal: p,
        requestId,
        events: [new ApprovalEvent('approval.decided', row)],
      });
      return row;
    };

    if (!approve) return this.decided(await this.db.transaction((tx) => close(tx, 'rejected')), p);
    if (found.expiresAt <= new Date())
      return this.decided(await this.db.transaction((tx) => close(tx, 'expired')), p);

    const stored = found.payload as Stored | null;
    const factory = stored?.op ? registry.get(stored.op)?.factory : undefined;
    if (!stored || !factory) {
      return this.decided(
        await this.db.transaction((tx) =>
          close(tx, 'failed', 'This request can no longer be replayed'),
        ),
        p,
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

        // Replay as the original requester, as they stand today (still in the business, still
        // allowed), marked approved by the decider, under this request.
        const requester = await this.resolver.refresh(stored.principal);
        const replayCtx: WriteCtx = {
          principal: { ...requester, approvedBy: deciderKey },
          requestId,
          idempotencyKey: `approval:${found.id}`,
          tx,
        };
        const out = await runWrite(this.db, replayCtx, factory(stored.args), stored.input);
        if (out.result.status !== 'done')
          throw new ConflictException('The replay was parked again');

        const [row] = await tx
          .update(approvals)
          .set({ status: 'approved', decidedAt: new Date(), decidedBy: deciderKey })
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
        await recordEvents(tx, {
          principal: p,
          requestId,
          events: [new ApprovalEvent('approval.decided', row)],
        });
        return { approval: row, events: out.events };
      });
      for (const event of events) this.events.publish(event);
      return this.decided(approval, p);
    } catch (e) {
      // Refused or missing on replay (the meeting was closed meanwhile): record why.
      if (e instanceof HttpException && [401, 403, 404, 409].includes(e.getStatus())) {
        const body = e.getResponse() as { reason?: string; message?: string };
        if (e.getStatus() === 409 && (body as { error?: string }).error === 'already_decided')
          throw e;
        return this.decided(
          await this.db.transaction((tx) =>
            close(tx, 'failed', body?.reason ?? body?.message ?? e.message),
          ),
          p,
        );
      }
      throw e;
    }
  }

  /**
   * Tell whoever listens in this process (a customer waiting on WhatsApp) how it ended. The
   * event was stored with the decision; this is its in-process publication after commit.
   */
  private decided(row: ApprovalRow, p: Principal): Approval {
    this.events.publish(new ApprovalEvent('approval.decided', row));
    return approvalFor(row, p);
  }
}
