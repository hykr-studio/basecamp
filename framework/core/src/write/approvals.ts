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
  levelOf,
  Money,
  type Principal,
  rolesOfBusiness,
  standingIn,
  type TenantConfig,
  teamRoles,
} from '@hykr/contracts';
import { approvals, type Database, membershipOf, memberships, writeAudit } from '@hykr/db';
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
import {
  and,
  arrayOverlaps,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
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

/**
 * Who decides it: the requester, one named person, or the holders of a capability. A named
 * person who is no longer on the business's team (`approverGone`) has given way to the holders
 * of `approvals.decide`.
 */
function deciderOf(row: ApprovalRow, approverGone = false): Decider {
  if (row.approverUserId && approverGone) return { by: 'capability', capability: DECIDE };
  if (row.approverUserId)
    return row.approverUserId === row.ownerId
      ? { by: 'requester', userId: row.approverUserId }
      : { by: 'person', userId: row.approverUserId };
  return row.approverCapability
    ? { by: 'capability', capability: row.approverCapability }
    : { by: 'capability' };
}

/** An approval row as stored: every field, for the server's own use. */
export function toApproval(row: ApprovalRow, approverGone = false): Approval {
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
    decider: deciderOf(row, approverGone),
  };
}

/**
 * May this person decide this request? Its named decider (the requester, when the policy sends
 * it back to them) while they are on the business's team, or a holder of its capability who is
 * not the requester: nobody approves their own request unless the policy says it is theirs to
 * decide. A named decider who left the team (`approverGone`, which `ApprovalService` looks up)
 * gives way to the holders of `approvals.decide`, as one who was never on it does when the
 * request parks.
 */
export function mayDecide(
  row: ApprovalRow,
  p: Principal,
  opts: { approverGone?: boolean } = {},
): boolean {
  if (row.tenantId !== p.tenantId) return false;
  const self = userIdOf(p);
  if (row.approverUserId && !opts.approverGone) return !!self && row.approverUserId === self;
  const capability = row.approverUserId ? DECIDE : row.approverCapability;
  if (!capability || !(p.capabilities ?? []).includes(capability)) return false;
  return !askedBy(row, p);
}

/** Did this principal ask for it? A member by their user id, a contact by its contact id. */
function askedBy(row: ApprovalRow, p: Principal): boolean {
  const s = subjectOf(p);
  if (s?.kind === 'user') return row.ownerId === s.userId;
  if (s?.kind === 'contact') return row.requesterContactId === s.contactId;
  return false;
}

/** The contact this principal is, if it is one. */
function contactIdOf(p: Principal): string | null {
  const s = subjectOf(p);
  return s?.kind === 'contact' ? s.contactId : null;
}

/**
 * An approval as one person may see it. The parked input of an entity's write is projected as
 * that entity's record (a hidden field stays hidden on the card), then the whole approval goes
 * through the read projectors as 'approval'. `canDecide` says whether they may decide it.
 */
export function approvalFor(row: ApprovalRow, p: Principal, approverGone = false): Approval {
  const approval = toApproval(row, approverGone);
  const def = entityDef(row.resourceType);
  const input = approval.input;
  const entityWrite = def && row.action.startsWith(`${def.name}.`);
  const seen =
    entityWrite && input && typeof input === 'object' && !Array.isArray(input)
      ? def.project(input as Record<string, unknown>, p)
      : input;
  return projectRead(
    'approval',
    { ...approval, input: seen, canDecide: mayDecide(row, p, { approverGone }) },
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
 * Is this principal on the business's team? A member (standing set by the server) holding a
 * role beyond those the framework hands outsiders. A contact, a participant, support access,
 * an operator, and a member holding only a contact's or participant's roles are outside. Its
 * roles are the ones the resolver found the business has.
 */
const onTeam = (p: Principal) => p.standing === 'member' && teamRoles(p.roles ?? []).length > 0;

/**
 * Who decides a parked action, most specific first: the decision's approver (an amount band's
 * named person), the operation's approval rule, then its level's policy. The first that says
 * `by` decides who; `channels` likewise; `minAssurance` is the strongest any of them asks.
 * Nobody says: a member of the team decides their own (assistant's) request, and anyone outside
 * it (a contact, a participant, a customer) asks the business, the holders of `approvals.decide`.
 */
async function decidersFor(
  tx: Tx,
  p: Principal,
  layers: readonly (Layer | undefined)[],
  amount: AuthorizeResult['amount'],
  settings: () => Promise<TenantConfig>,
): Promise<Deciders> {
  const self = userIdOf(p);
  const by = layers.find((l) => l?.by !== undefined)?.by;
  const channels = layers.find((l) => l?.channels !== undefined)?.channels;
  const assurances = layers.flatMap((l) => (l?.minAssurance ? [l.minAssurance] : []));
  const minAssurance = assurances.reduce<Assurance | null>(
    (most, a) => (most && atLeast(most, a) ? most : a),
    null,
  );

  let who: ApproverBy = by ?? (self && onTeam(p) ? 'requester' : business());
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
    // A named person decides alone: never the requester, and only a member of this business's
    // team, by the roles it has (its own and its edits; a name it lacks counts for nothing).
    const member =
      who.userId !== self && p.tenantId
        ? await membershipOf(tx, who.userId, p.tenantId)
        : undefined;
    const held = member ? standingIn(member.roles, await settings()).roles : [];
    if (!teamRoles(held).length) who = business();
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

/** The role names that put someone on this business's team: its roles no outsider is given. */
async function teamOf(conn: Database | Tx, tenantId: string | undefined): Promise<string[]> {
  return teamRoles(rolesOfBusiness(await settingsIn(conn, tenantId)).map((r) => r.name));
}

/**
 * Is the request's named approver on its business's team now (a membership with a team role)?
 * A business with no team role has nobody on its team.
 */
const approverOnTeam = (team: readonly string[]): SQL =>
  team.length === 0
    ? sql`false`
    : sql`exists (select 1 from ${memberships} where ${and(
        eq(memberships.tenantId, approvals.tenantId),
        eq(memberships.userId, approvals.approverUserId),
        arrayOverlaps(memberships.roles, [...team]),
      )})`;

/**
 * Of these requests, the ones whose named approver is no longer on the business's team (left
 * it, or holds only an outsider's roles now): by id. `team` is `teamOf` the business.
 */
async function goneApprovers(
  conn: Database | Tx,
  rows: readonly ApprovalRow[],
  team: readonly string[],
): Promise<Set<string>> {
  const named = rows.filter((r) => r.approverUserId);
  if (!named.length) return new Set();
  const found = await conn
    .select({
      tenantId: memberships.tenantId,
      userId: memberships.userId,
      roles: memberships.roles,
    })
    .from(memberships)
    .where(
      and(
        inArray(memberships.tenantId, [...new Set(named.map((r) => r.tenantId))]),
        inArray(memberships.userId, [...new Set(named.map((r) => r.approverUserId as string))]),
      ),
    );
  const onTeam = new Set(
    found
      .filter((m) => m.roles.some((r) => team.includes(r)))
      .map((m) => `${m.tenantId}:${m.userId}`),
  );
  return new Set(
    named.filter((r) => !onTeam.has(`${r.tenantId}:${r.approverUserId}`)).map((r) => r.id),
  );
}

/**
 * The approvals this principal may decide, in its business: the ones that name them (while they
 * are on its team), the ones whose capability they hold that they did not ask for, and, for a
 * holder of `approvals.decide`, the ones whose named approver is off the team now. Everything
 * else is a 404, never a hint it exists. (`mayDecide` is the same rule for one row.)
 */
function decidable(p: Principal, team: readonly string[]): SQL {
  const self = userIdOf(p);
  const contact = contactIdOf(p);
  const held = p.capabilities ?? [];
  const notTheirs = [
    ...(self ? [or(isNull(approvals.ownerId), ne(approvals.ownerId, self))] : []),
    ...(contact
      ? [or(isNull(approvals.requesterContactId), ne(approvals.requesterContactId, contact))]
      : []),
  ];
  const named = approverOnTeam(team);
  const mine = [
    ...(self ? [and(eq(approvals.approverUserId, self), named)] : []),
    ...(held.length
      ? [
          and(
            isNull(approvals.approverUserId),
            inArray(approvals.approverCapability, held),
            ...notTheirs,
          ),
        ]
      : []),
    ...(held.includes(DECIDE)
      ? [and(isNotNull(approvals.approverUserId), not(named), ...notTheirs)]
      : []),
  ];
  return and(
    eq(approvals.tenantId, p.tenantId ?? ''),
    mine.length ? or(...mine) : eq(approvals.id, ''),
  ) as SQL;
}

/** What this principal may open: what they decide, and their own requests (read only). */
function visible(p: Principal, team: readonly string[]): SQL {
  const self = userIdOf(p);
  if (!self) return decidable(p, team);
  return or(
    decidable(p, team),
    and(eq(approvals.tenantId, p.tenantId ?? ''), eq(approvals.ownerId, self)),
  ) as SQL;
}

const notFound = () => new NotFoundException({ error: 'not_found', message: 'No such approval' });

/**
 * A replay refused with one of these ends the request as failed: it would be refused again.
 * Anything else (a 5xx, a 429) leaves it pending, to be decided again.
 */
const REPLAY_REFUSED = [400, 401, 403, 404, 409, 410, 422];

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
    const team = await teamOf(this.db, p.tenantId);
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), visible(p, team)));
    if (!row) throw notFound();
    const gone = await goneApprovers(this.db, [row], team);
    return approvalFor(row, p, gone.has(row.id));
  }

  /** What waits for this person's decision, oldest first. */
  async pending(p: Principal): Promise<Approval[]> {
    const team = await teamOf(this.db, p.tenantId);
    const rows = await this.db
      .select()
      .from(approvals)
      .where(and(decidable(p, team), eq(approvals.status, 'pending')))
      .orderBy(asc(approvals.createdAt));
    const gone = await goneApprovers(this.db, rows, team);
    return rows.map((row) => approvalFor(row, p, gone.has(row.id)));
  }

  async decide(p: Principal, id: string, approve: boolean, requestId: string): Promise<Approval> {
    // Only what this principal may see: someone else's approval id is a 404, not a 403.
    const team = await teamOf(this.db, p.tenantId);
    const [found] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), visible(p, team)));
    if (!found) throw notFound();
    const approverGone = (await goneApprovers(this.db, [found], team)).has(found.id);
    // Their own request, which someone else decides: they may look, never decide.
    if (!mayDecide(found, p, { approverGone }))
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

    if (!approve)
      return this.decided(
        await this.db.transaction((tx) => close(tx, 'rejected')),
        p,
        approverGone,
      );
    if (found.expiresAt <= new Date())
      return this.decided(await this.db.transaction((tx) => close(tx, 'expired')), p, approverGone);

    const stored = found.payload as Stored | null;
    const factory = stored?.op ? registry.get(stored.op)?.factory : undefined;
    if (!stored || !factory) {
      return this.decided(
        await this.db.transaction((tx) =>
          close(tx, 'failed', 'This request can no longer be replayed'),
        ),
        p,
        approverGone,
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
      return this.decided(approval, p, approverGone);
    } catch (e) {
      // What was asked no longer validates (a field taken out of the stored input since, by an
      // erasure's scrubbing): no approval will ever replay it, so it ends as failed.
      if (e instanceof z.ZodError) {
        const where = e.issues.map((i) => i.path.join('.') || '(input)').join(', ');
        return this.decided(
          await this.db.transaction((tx) =>
            close(tx, 'failed', `What was asked is no longer complete (${where})`.slice(0, 500)),
          ),
          p,
          approverGone,
        );
      }
      // Refused, missing or invalid on replay (the meeting was closed meanwhile, a command's own
      // 400): record why. A request repeated later would be refused the same way.
      if (e instanceof HttpException && REPLAY_REFUSED.includes(e.getStatus())) {
        const body = e.getResponse() as { reason?: string; message?: string };
        if (e.getStatus() === 409 && (body as { error?: string }).error === 'already_decided')
          throw e;
        return this.decided(
          await this.db.transaction((tx) =>
            close(tx, 'failed', body?.reason ?? body?.message ?? e.message),
          ),
          p,
          approverGone,
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
  private decided(row: ApprovalRow, p: Principal, approverGone = false): Approval {
    this.events.publish(new ApprovalEvent('approval.decided', row));
    return approvalFor(row, p, approverGone);
  }
}
