import { randomUUID } from 'node:crypto';
import {
  type Approval,
  ApprovalCapabilities,
  type ApprovalLevelInfo,
  type ApproverBy,
  type ApproverRule,
  type Assurance,
  type AuthorizeResult,
  approverOf,
  atLeast,
  bandApprover,
  capabilities,
  checkApprovalLevels,
  type Decider,
  type DecisionDetails,
  givenRoles,
  levelOf,
  Money,
  type Principal,
  type TenantConfig,
} from '@hykr/contracts';
import { approvals, type Database, membershipOf, writeAudit } from '@hykr/db';
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
import { and, asc, eq, inArray, isNull, lte, ne, or, type SQL } from 'drizzle-orm';
import type { NamedEvent } from '../entity/cqrs-classes.js';
import { entityDef } from '../entity/registry.js';
import { projectRead } from '../hooks.js';
import { PrincipalResolver } from '../http/resolver.js';
import { systemPrincipal } from '../system.js';
import { CORE_OPTIONS, type CoreOptions, type Tx } from '../tokens.js';
import { recordEvents } from './events.js';
import { effectiveLevel, settingsIn } from './levels.js';
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

/** Who decides one request, as stored on its row. */
type Deciders = Pick<
  ApprovalRow,
  'approverUserId' | 'approverCapability' | 'approverChannels' | 'minAssurance'
>;

const DECIDE = ApprovalCapabilities.decide.name;

/** The level a request parked at, as a card shows it: its rank and label while it is declared. */
function levelInfo(name: string | null): ApprovalLevelInfo | null {
  if (!name) return null;
  const def = levelOf(name);
  return def ? { name, rank: def.rank, label: def.label } : { name };
}

/** Who decides it: the requester, one named person, or the holders of a capability. */
function deciderOf(row: ApprovalRow): Decider {
  if (row.approverUserId)
    return row.approverUserId === row.ownerId
      ? { by: 'requester', userId: row.approverUserId }
      : { by: 'person', userId: row.approverUserId };
  return row.approverCapability
    ? { by: 'capability', capability: row.approverCapability }
    : { by: 'capability' };
}

/** An approval row as stored: every field, for the server's own use. */
export function toApproval(row: ApprovalRow): Approval {
  const stored = row.payload as Stored | null;
  const amount = Money.safeParse(stored?.decision?.amount);
  return {
    id: row.id,
    action: row.action,
    rule: row.rule,
    reason: row.reason,
    status: row.status as Approval['status'],
    summary: row.summary ?? (row.payload as { summary?: string } | null)?.summary ?? null,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    input: stored?.input ?? null,
    requestedBy: row.requestedBy,
    expiresAt: row.expiresAt.toISOString(),
    failureReason: row.failureReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    level: levelInfo(row.level),
    amount: amount.success ? amount.data : null,
    decider: deciderOf(row),
  };
}

/**
 * May this person decide this request? Its named decider (the requester, when the policy sends
 * it back to them), or a holder of its capability who is not the requester: nobody approves
 * their own request unless the policy says it is theirs to decide.
 */
export function mayDecide(row: ApprovalRow, p: Principal): boolean {
  if (row.tenantId !== p.tenantId) return false;
  const self = userIdOf(p);
  if (row.approverUserId) return !!self && row.approverUserId === self;
  if (!row.approverCapability || !(p.capabilities ?? []).includes(row.approverCapability))
    return false;
  return !self || row.ownerId !== self;
}

/**
 * An approval as one person may see it. The parked input of an entity's write is projected as
 * that entity's record (a hidden field stays hidden on the card), then the whole approval goes
 * through the read projectors as 'approval'. `canDecide` says whether they may decide it.
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
  return projectRead(
    'approval',
    { ...approval, input: seen, canDecide: mayDecide(row, p) },
    p,
  ) as Approval;
}

let ttlMs = DEFAULT_TTL_MS;
export function setApprovalTtl(ms: number) {
  ttlMs = ms;
}

/** One layer of who decides: a decision's approver, an approval rule, a level's policy. */
type Layer = Pick<ApproverRule, 'by' | 'channels' | 'minAssurance'>;

/** Holders of `approvals.decide`, never the requester: the fallback decider. */
const business = (): ApproverBy => ({ capability: DECIDE });

/**
 * The roles the framework hands people outside the team: a contact's and a participant's, as the
 * application names them (`roleDefaults`; the framework's own is `customer`).
 */
const outsiderRoles = () => new Set([...givenRoles('contact'), ...givenRoles('participant')]);

/** Does a person hold no role but those handed to people outside the team? */
const onlyOutside = (roles: readonly string[]) => {
  const outside = outsiderRoles();
  return !roles.some((r) => !outside.has(r));
};

/**
 * Who decides a parked action, most specific first: the decision's approver (an amount band's
 * named person), the operation's approval rule, then its level's policy. The first that says
 * `by` decides who; `channels` likewise; `minAssurance` is the strongest any of them asks.
 * Nobody says: the person it is for decides their own (assistant's) request, and a customer's
 * (or a contact's, or a participant's: anyone holding only the roles the framework hands people
 * outside the team) goes to the business, the holders of `approvals.decide`.
 */
async function decidersFor(
  tx: Tx,
  p: Principal,
  layers: readonly (Layer | undefined)[],
  amount: AuthorizeResult['amount'],
  settings: () => Promise<TenantConfig>,
): Promise<Deciders> {
  const self = userIdOf(p);
  // Someone outside the team (a customer, a participant, however the application names their
  // roles) never decides their own request: the business does.
  const roles = p.roles ?? [];
  const customer = p.standing === 'participant' || (roles.length > 0 && onlyOutside(roles));
  const by = layers.find((l) => l?.by !== undefined)?.by;
  const channels = layers.find((l) => l?.channels !== undefined)?.channels;
  const assurances = layers.flatMap((l) => (l?.minAssurance ? [l.minAssurance] : []));
  const minAssurance = assurances.reduce<Assurance | null>(
    (most, a) => (most && atLeast(most, a) ? most : a),
    null,
  );

  let who: ApproverBy = by ?? (self && !customer ? 'requester' : business());
  if (typeof who === 'object' && 'band' in who) {
    // The business's settings name who decides each amount band; no band fits: the business.
    const named = bandApprover(await settings(), who.band, amount);
    who =
      named && 'capability' in named && !capabilities.has(named.capability)
        ? business()
        : (named ?? business());
  }
  if (who === 'requester' && !self) who = business();
  if (typeof who === 'object' && 'userId' in who) {
    // A named person decides alone: never the requester, and only a member of this business.
    const member =
      who.userId !== self && p.tenantId
        ? await membershipOf(tx, who.userId, p.tenantId)
        : undefined;
    if (!member || onlyOutside(member.roles)) who = business();
  }
  if (typeof who === 'object' && 'capability' in who && !capabilities.has(who.capability))
    throw new Error(`An approval is decided by "${who.capability}", which nobody defines`);

  return {
    approverUserId:
      who === 'requester' ? self : typeof who === 'object' && 'userId' in who ? who.userId : null,
    approverCapability: typeof who === 'object' && 'capability' in who ? who.capability : null,
    approverChannels: channels ? [...channels] : null,
    minAssurance,
  };
}

const detailsOf = (r: AuthorizeResult): DecisionDetails | undefined => {
  const out: DecisionDetails = {};
  if (r.level !== undefined) out.level = r.level;
  if (r.approver !== undefined) out.approver = r.approver;
  if (r.amount !== undefined) out.amount = r.amount;
  if (r.undoMs !== undefined) out.undoMs = r.undoMs;
  return Object.keys(out).length ? out : undefined;
};

/**
 * Store the operation, its validated input and who asked; whoever may decide does, later. Who
 * decides, where, how surely and for how long come from the decision, the operation's rule and
 * the level's policy, with the business's settings (`settings` when the write already read them).
 */
export async function parkForApproval<I, L>(
  tx: Tx,
  ctx: WriteCtx,
  // biome-ignore lint/suspicious/noExplicitAny: any operation can be parked
  op: WriteOp<I, L, any>,
  input: I,
  loaded: L,
  result: AuthorizeResult,
  settings?: TenantConfig,
): Promise<{ approval: Approval; event: ApprovalEvent }> {
  const p = ctx.principal;
  const subject = subjectOf(p);
  if (!subject || !p.tenantId) throw new ConflictException('Nobody to ask for approval');
  let config = settings;
  const settingsOf = async () => {
    config ??= await settingsIn(tx, p.tenantId);
    return config;
  };
  const level = result.level !== undefined ? levelOf(result.level) : undefined;
  const deciders = await decidersFor(
    tx,
    p,
    [result.approver, approverOf(op.approval), level?.policy?.approver],
    result.amount,
    settingsOf,
  );
  const expiresInMs =
    result.level !== undefined
      ? (effectiveLevel(result.level, p, await settingsOf()).expiresInMs ?? ttlMs)
      : ttlMs;
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
      ...deciders,
      approverRoles: [],
      level: result.level ?? null,
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
      expiresAt: new Date(Date.now() + expiresInMs),
    })
    .returning();
  return { approval: approvalFor(row, p), event: new ApprovalEvent('approval.requested', row) };
}

/**
 * The approvals this principal may decide, in its business: the ones that name them, and the
 * ones whose capability they hold that they did not ask for. Everything else is a 404, never a
 * hint it exists. (`mayDecide` is the same rule for one row.)
 */
function decidable(p: Principal): SQL {
  const self = userIdOf(p);
  const held = p.capabilities ?? [];
  const mine = [
    ...(self ? [eq(approvals.approverUserId, self)] : []),
    ...(held.length
      ? [
          and(
            isNull(approvals.approverUserId),
            inArray(approvals.approverCapability, held),
            ...(self ? [or(isNull(approvals.ownerId), ne(approvals.ownerId, self))] : []),
          ),
        ]
      : []),
  ];
  return and(
    eq(approvals.tenantId, p.tenantId ?? ''),
    mine.length ? or(...mine) : eq(approvals.id, ''),
  ) as SQL;
}

/** What this principal may open: what they decide, and their own requests (read only). */
function visible(p: Principal): SQL {
  const self = userIdOf(p);
  if (!self) return decidable(p);
  return or(
    decidable(p),
    and(eq(approvals.tenantId, p.tenantId ?? ''), eq(approvals.ownerId, self)),
  ) as SQL;
}

const notFound = () => new NotFoundException({ error: 'not_found', message: 'No such approval' });

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
    // When the API or worker starts: two levels of one rank, or a level decided by a capability
    // nobody defines, stops it.
    checkApprovalLevels();
  }

  /** One request: one they may decide, or their own (with `canDecide` false when not theirs). */
  async get(p: Principal, id: string): Promise<Approval> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), visible(p)));
    if (!row) throw notFound();
    return approvalFor(row, p);
  }

  /** What waits for this person's decision, oldest first. */
  async pending(p: Principal): Promise<Approval[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(and(decidable(p), eq(approvals.status, 'pending')))
      .orderBy(asc(approvals.createdAt));
    return rows.map((row) => approvalFor(row, p));
  }

  async decide(p: Principal, id: string, approve: boolean, requestId: string): Promise<Approval> {
    // Only what this principal may see: someone else's approval id is a 404, not a 403.
    const [found] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), visible(p)));
    if (!found) throw notFound();
    // Their own request, which someone else decides: they may look, never decide.
    if (!mayDecide(found, p))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'own_request',
        reason: 'Someone else decides this request',
      });
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
        // allowed), marked approved by the decider, under this request. What was approved (the
        // level and the amount) bounds it: a replay that now needs more fails.
        const requester = await this.resolver.refresh(stored.principal);
        const replayCtx: WriteCtx = {
          principal: { ...requester, approvedBy: deciderKey },
          requestId,
          idempotencyKey: `approval:${found.id}`,
          tx,
          approved: {
            ...(found.level ? { level: found.level } : {}),
            ...(stored.decision?.amount ? { amount: stored.decision.amount } : {}),
          },
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
   * The sweeper (the `approvals.expire` schedule): requests nobody decided in time become
   * `expired`, audited as the system, with `approval.decided` stored and published, so the
   * customer who asked hears it. Up to `limit` at a time; returns how many.
   */
  async expireDue(limit = 100): Promise<number> {
    const requestId = `approvals.expire:${randomUUID()}`;
    const expired = await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, new Date())))
        .orderBy(asc(approvals.expiresAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      const rows: ApprovalRow[] = [];
      for (const found of due) {
        const system = systemPrincipal({ tenantId: found.tenantId, job: 'approvals.expire' });
        const [row] = await tx
          .update(approvals)
          .set({ status: 'expired', decidedAt: new Date(), decidedBy: 'system' })
          .where(eq(approvals.id, found.id))
          .returning();
        await writeAudit(tx, {
          ...auditCtx(
            system,
            { rule: 'approval_expired', reason: 'Nobody decided it in time' },
            { principal: system, requestId },
          ),
          action: 'approval.expired',
          resourceType: 'approval',
          resourceId: found.id,
          before: found,
          after: row,
        });
        await recordEvents(tx, {
          principal: system,
          requestId,
          events: [new ApprovalEvent('approval.decided', row)],
        });
        rows.push(row);
      }
      return rows;
    });
    for (const row of expired) this.events.publish(new ApprovalEvent('approval.decided', row));
    return expired.length;
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
