// The agents feature's bookkeeping: starting runs when triggers fire (time, events, conditions,
// messages, mentions, webhooks), the run token's identity, budgets, and the run log. The run
// itself is AgentRunner's. docs/decisions/A6.md.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { agentRunToken } from '@hykr/agents';
import {
  AGENT_RUN_HEADER,
  AgentBudget,
  AgentCapabilities,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunPage,
  AgentRunsQuery,
  AgentScope,
  type AgentTemplateInfo,
  AgentTrigger,
  CommentCapabilities,
  type DomainEventEnvelope,
  FrameworkCapabilities,
  type Principal,
  type ThreadMessage,
  type ToolCallSummary,
} from '@hykr/contracts';
import {
  type AgentIdentity,
  type Conn,
  entityDef,
  eventFor,
  type IdentityRequest,
  PrincipalResolver,
  RUN_ID,
  recordEvents,
  systemPrincipal,
  tenantZoneOf,
} from '@hykr/core';
import { type Database, schema } from '@hykr/db';
import { type Lang, pick } from '@hykr/i18n';
import { can } from '@hykr/policy';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import type { InboundInfo, Jobs, ServerContext } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import type { SavedPart } from '../../modules/threads/threads.service.js';
import { JOBS } from '../../queues/define.js';
import { serverContext } from '../../queues/jobs.service.js';
import { runtime } from '../../runtime.js';
import { matchesEvent } from '../events/subscriber.js';
import { liveResources } from '../live/resources.js';
import { allToolIds, scopesFor } from './scope.js';
import { agentTemplates, setAgentWebhookSink } from './templates.js';
import {
  eventMatches,
  messageMatches,
  nextDue,
  resolveWhere,
  triggerLabel,
  webhookMatches,
} from './triggers.js';

const { agents, agentTriggers, agentRuns, agentConditionHits, approvals, usageEvents } = schema;
const { threadMessages } = schema;

export type AgentRow = typeof agents.$inferSelect;
export type RunRow = typeof agentRuns.$inferSelect;
type TriggerRow = typeof agentTriggers.$inferSelect;

const log = new Logger('Agents');

/** Was this trigger saved after the event happened? Then the event is not its to see. */
const savedAfter = (createdAt: Date, event: { occurredAt: string }) =>
  createdAt.getTime() > Date.parse(event.occurredAt);

/** The queue runs go on, and its job ids. */
export const RUN_QUEUE = 'agents.run';
export const runJobId = (id: string) => `agent-run--${id}`;

/** At this depth (runs of agents started by other agents' runs) nothing more starts. */
export const MAX_DEPTH = 3;
/** At most this many runs of one agent queued or running at once. */
export const MAX_OPEN = 10;
/** A condition starts at most this many runs per check. */
const CONDITION_RUNS = 10;
/** A run `running` this long has lost its worker. */
const STALE_RUNNING_MS = 15 * 60_000;
/** A run `queued` this long has lost its job. */
const LOST_JOB_MS = 30_000;

/** The statuses a run token works in. */
const LIVE = new Set(['running', 'waiting']);

const sha256 = (s: string) => createHash('sha256').update(s).digest();

const headerOf = (req: IdentityRequest, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** A fresh run id that doubles as a trace id (32 hex chars), as the chat's. */
export const newRunId = () => randomUUID().replaceAll('-', '');

/** One run to start: which agent, what fired it, and what it reads. */
export interface RunStart {
  agent: AgentRow;
  triggerId?: string | null;
  kind: AgentRun['trigger']['kind'];
  label: string;
  input?: unknown;
  /** One run per agent and dedupe key: a trigger firing twice for one thing runs once. */
  dedupe: string;
  depth?: number;
}

/** A run as the log shows it. */
export function toRun(r: RunRow): AgentRun {
  return {
    id: r.id,
    agentId: r.agentId,
    runId: r.runId,
    trigger: { kind: r.triggerKind as AgentRun['trigger']['kind'], label: r.triggerLabel },
    status: r.status,
    reason: r.reason,
    reply: r.reply,
    toolCalls: (r.toolCalls as ToolCallSummary[]) ?? [],
    usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens },
    model: r.model,
    agentVersion: r.agentVersion,
    depth: r.depth,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** A run's change, for live updates and subscribers: `agent.run.finished`, `agent.run.waiting`. */
class AgentRunEvent {
  readonly resourceType = 'agent_run';
  constructor(
    readonly eventName: string,
    readonly row: { id: string; agentId: string; runId: string; status: string; ownerId: string },
  ) {}
  get resourceId() {
    return this.row.id;
  }
}

/** A run was asked for by a person (run now): the `agents.requested` subscriber queues it. */
export class AgentRunRequested {
  readonly eventName = 'agent.run.requested';
  readonly resourceType = 'agent_run';
  constructor(readonly row: { id: string; agentId: string; runId: string; ownerId: string }) {}
  get resourceId() {
    return this.row.id;
  }
}

let current: AgentsService | undefined;
/** The running agents service, once the feature has started (the hooks reach it here). */
export const agentsService = () => current;

const Triggers = z.array(AgentTrigger);

@Injectable()
export class AgentsService implements OnModuleInit, OnModuleDestroy {
  private readonly ctx: ServerContext;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JOBS) private readonly jobs: Jobs,
    private readonly resolver: PrincipalResolver,
    @Inject(ModuleRef) ref: ModuleRef,
  ) {
    this.ctx = serverContext(ref);
  }

  onModuleInit() {
    current = this;
    setAgentWebhookSink((e) => this.onWebhook(e));
  }

  onModuleDestroy() {
    if (current === this) current = undefined;
    setAgentWebhookSink(undefined);
  }

  get database() {
    return this.db;
  }

  /** The business's time zone (`tenantZone`: its own, else the deployment's, else UTC). */
  zone(tenantId: string): Promise<string> {
    return tenantZoneOf(this.db, tenantId);
  }

  /* ── Who a run is ────────────────────────────────────────────────────── */

  /** The agent's owner as a principal of its runs: their standing now, narrowed by its scope. */
  async ownerPrincipal(agent: AgentRow, runId?: string): Promise<Principal | null> {
    try {
      const standing = await this.resolver.forUser(agent.ownerId, {
        tenantId: agent.tenantId,
        channel: 'background',
      });
      const scope = AgentScope.safeParse(agent.scope);
      return {
        actor: { kind: 'agent', id: `agent:${agent.id}` },
        actingFor: { userId: agent.ownerId },
        ...standing,
        scopes: scopesFor(scope.success ? scope.data.tools : [], runtime().catalog),
        channel: 'background',
        ...(runId ? { runId } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * The `agent-run` identity provider: a run's token (an HMAC of its run id), for a run that is
   * running or waiting, of an active agent. It acts for the owner, in the run's business, on the
   * background channel, with its version and scope. Anything else that carries the header is 401.
   */
  async identify(req: IdentityRequest): Promise<AgentIdentity | null> {
    const token = headerOf(req, AGENT_RUN_HEADER);
    if (!token) return null;
    const runId = headerOf(req, 'x-run-id');
    if (!runId || !RUN_ID.test(runId))
      throw new UnauthorizedException('An agent run needs x-run-id');
    if (!config.agentApiKey) throw new UnauthorizedException('Agent runs are off here');
    if (!timingSafeEqual(sha256(token), sha256(agentRunToken(runId, config.agentApiKey))))
      throw new UnauthorizedException('Invalid agent run token');
    const [row] = await this.db
      .select({ run: agentRuns, agent: agents })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(eq(agentRuns.runId, runId));
    if (!row || !LIVE.has(row.run.status))
      throw new UnauthorizedException('This agent run is not running');
    if (row.agent.status !== 'active') throw new UnauthorizedException('This agent is paused');
    const named = headerOf(req, 'x-acting-for');
    if (named && named !== `user:${row.agent.ownerId}` && named !== row.agent.ownerId)
      throw new UnauthorizedException("x-acting-for is not this agent's owner");
    const scope = AgentScope.safeParse(row.agent.scope);
    return {
      agentId: `agent:${row.agent.id}`,
      actingFor: { userId: row.agent.ownerId },
      tenantId: row.run.tenantId,
      channel: 'background',
      runId,
      ...(row.run.agentVersion ? { agentVersion: row.run.agentVersion } : {}),
      // The run's own narrowing, which this feature enforces (scope.ts), not route scopes: a
      // run's tools reach only what its scope holds, as its owner.
      narrowing: scopesFor(scope.success ? scope.data.tools : [], runtime().catalog),
    };
  }

  /* ── Starting runs ───────────────────────────────────────────────────── */

  /**
   * Record a run and queue it. Nothing starts for a paused agent, past the depth limit, with too
   * many open runs, or twice for one dedupe key. Returns the run's id, or null.
   */
  async start(a: RunStart): Promise<string | null> {
    const id = await this.record(this.db, a);
    if (id) await this.enqueue(id);
    return id;
  }

  /** Record a queued run (the checks of `start`) without queueing it: in a transaction. */
  private async record(conn: Conn, a: RunStart): Promise<string | null> {
    const depth = a.depth ?? 0;
    if (a.agent.status !== 'active') return null;
    if (depth > MAX_DEPTH) {
      log.warn(`agent=${a.agent.id}: depth ${depth} is past ${MAX_DEPTH}; not started`);
      return null;
    }
    const [{ open }] = await conn
      .select({ open: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.agentId, a.agent.id), inArray(agentRuns.status, ['queued', 'running'])),
      );
    if (open >= MAX_OPEN) {
      log.warn(`agent=${a.agent.id}: ${open} runs open; not started (${a.kind})`);
      return null;
    }
    const [row] = await conn
      .insert(agentRuns)
      .values({
        tenantId: a.agent.tenantId,
        agentId: a.agent.id,
        runId: newRunId(),
        triggerId: a.triggerId ?? null,
        triggerKind: a.kind,
        triggerLabel: a.label,
        input: (a.input ?? null) as never,
        dedupe: a.dedupe,
        depth,
        queues: config.queuePrefix,
      })
      .onConflictDoNothing()
      .returning({ id: agentRuns.id });
    return row?.id ?? null;
  }

  /** Put a queued run on the queue (once: the job id is the run's). */
  async enqueue(id: string) {
    await this.jobs.add(RUN_QUEUE, { id }, { name: 'run', jobId: runJobId(id) });
  }

  /** Run now, inside the command's transaction: the queued run and the event that queues it. */
  async requestIn(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    agent: AgentRow,
    note?: string,
  ): Promise<RunRow> {
    const [row] = await tx
      .insert(agentRuns)
      .values({
        tenantId: agent.tenantId,
        agentId: agent.id,
        runId: newRunId(),
        triggerKind: 'manual',
        triggerLabel: triggerLabel({ kind: 'manual' }),
        input: (note ? { note } : null) as never,
        dedupe: `manual:${randomUUID()}`,
        queues: config.queuePrefix,
      })
      .returning();
    return row;
  }

  /** The active agents of a business with a trigger of this kind, with that trigger. */
  private async triggersOf(tenantId: string, kind: AgentTrigger['kind']) {
    return this.db
      .select({ agent: agents, trigger: agentTriggers })
      .from(agentTriggers)
      .innerJoin(agents, eq(agents.id, agentTriggers.agentId))
      .where(
        and(
          eq(agentTriggers.tenantId, tenantId),
          eq(agentTriggers.kind, kind),
          eq(agents.status, 'active'),
        ),
      );
  }

  /** The run a write came from, if one of the agents made it: who, and how deep. */
  private async runOf(runId: string | undefined) {
    if (!runId) return undefined;
    const [row] = await this.db
      .select({ agentId: agentRuns.agentId, depth: agentRuns.depth })
      .from(agentRuns)
      .where(eq(agentRuns.runId, runId));
    return row;
  }

  /** May the owner read this record now? An entity's scoped read, or a contributed check. */
  private async ownerReads(owner: Principal, type: string, id: string | null): Promise<boolean> {
    if (!id) return false;
    const def = entityDef(type);
    try {
      if (def) return !!(await def.repo.find(this.db, owner, id));
      const check = liveResources.get(type);
      return check ? await check.visible(owner, id, this.ctx) : false;
    } catch {
      return false;
    }
  }

  /**
   * A stored event: every active agent of its business with a matching `event` trigger saved
   * before the event happened, for a record its owner may read, starts a run with the event as
   * the owner sees it. A run's own events never start the same agent again.
   */
  async onEvent(event: DomainEventEnvelope): Promise<number> {
    const found = await this.triggersOf(event.tenantId, 'event');
    if (!found.length) return 0;
    const from = await this.runOf(event.runId);
    let started = 0;
    for (const { agent, trigger } of found) {
      if (from?.agentId === agent.id) continue;
      // An event held (an undo window) or relayed late is not news to a trigger saved since.
      if (savedAfter(trigger.createdAt, event)) continue;
      const t = AgentTrigger.safeParse(trigger.spec);
      if (!t.success || t.data.kind !== 'event') continue;
      if (!t.data.on.some((p) => matchesEvent(p, event.name))) continue;
      const owner = await this.ownerPrincipal(agent);
      if (!owner || !(await this.ownerReads(owner, event.resourceType, event.resourceId))) continue;
      const seen = eventFor(event, owner);
      if (!seen || !eventMatches(t.data, event, seen.row)) continue;
      const id = await this.start({
        agent,
        triggerId: trigger.id,
        kind: 'event',
        label: `on ${event.name}`,
        input: {
          event: {
            name: event.name,
            type: event.resourceType,
            id: event.resourceId,
            at: event.occurredAt,
            by: event.actor.kind,
          },
          record: seen.row,
          ...(seen.before !== undefined ? { before: seen.before } : {}),
        },
        dedupe: `event:${event.id}`,
        depth: from ? from.depth + 1 : 0,
      });
      if (id) started++;
    }
    return started;
  }

  /** `comment.mentioned` for an agent: that agent runs with the comment. */
  async onMention(event: DomainEventEnvelope): Promise<string | null> {
    const row = event.row as {
      commentId?: string;
      on?: { entity: string; id: string };
      target?: { kind: string; id: string };
      author?: { id: string; name: string | null };
      internal?: boolean;
      excerpt?: string;
    } | null;
    if (row?.target?.kind !== 'agent' || !row.on) return null;
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, row.target.id), eq(agents.tenantId, event.tenantId)));
    if (!agent || !Triggers.safeParse(agent.triggers).data?.some((t) => t.kind === 'mention'))
      return null;
    const owner = await this.ownerPrincipal(agent);
    if (!owner || !(await this.mayBeMentioned(owner, row.on, !!row.internal))) return null;
    const from = await this.runOf(event.runId);
    if (from?.agentId === agent.id) return null;
    const [trigger] = await this.db
      .select({ id: agentTriggers.id, createdAt: agentTriggers.createdAt })
      .from(agentTriggers)
      .where(and(eq(agentTriggers.agentId, agent.id), eq(agentTriggers.kind, 'mention')))
      .limit(1);
    // No saved trigger row is no time to compare with: nothing starts (as for an event trigger).
    if (!trigger || savedAfter(trigger.createdAt, event)) return null;
    return this.start({
      agent,
      triggerId: trigger.id,
      kind: 'mention',
      label: `on an @-mention by ${row.author?.name ?? 'someone'}`,
      input: {
        comment: {
          id: row.commentId,
          on: row.on,
          author: row.author,
          internal: !!row.internal,
          excerpt: row.excerpt,
        },
      },
      dedupe: `mention:${event.id}`,
      depth: from ? from.depth + 1 : 0,
    });
  }

  /** May the owner be named on this record (as the mention kind checks it)? */
  async mayBeMentioned(owner: Principal, on: { entity: string; id: string }, internal: boolean) {
    if (internal && !can(owner, CommentCapabilities.internal)) return false;
    return this.ownerReads(owner, on.entity, on.id);
  }

  /**
   * A WhatsApp message to the business (the inbound hook): each active agent with a matching
   * `message` trigger, whose owner works in the back office, runs with the sender and the text.
   * The message still goes to the assistant: this never takes it.
   */
  async onInbound(msg: InboundInfo): Promise<number> {
    const body = msg.message.body;
    const text =
      body.kind === 'text'
        ? body.text
        : body.kind === 'button'
          ? (body.text ?? '')
          : body.kind === 'media'
            ? (body.caption ?? '')
            : '';
    if (!text.trim()) return 0;
    const found = await this.triggersOf(msg.tenantId, 'message');
    let started = 0;
    for (const { agent, trigger } of found) {
      const t = AgentTrigger.safeParse(trigger.spec);
      if (!t.success || t.data.kind !== 'message' || !messageMatches(t.data, text)) continue;
      const owner = await this.ownerPrincipal(agent);
      if (!owner || !can(owner, FrameworkCapabilities.backOffice)) continue;
      const id = await this.start({
        agent,
        triggerId: trigger.id,
        kind: 'message',
        label: triggerLabel(t.data),
        input: {
          message: {
            from: { contactId: msg.contactId, name: msg.message.profileName ?? null },
            text: text.slice(0, 2000),
            at: msg.message.at.toISOString(),
          },
        },
        dedupe: `inbound:${msg.message.providerMessageId}`,
      });
      if (id) started++;
    }
    return started;
  }

  /** A stored inbound webhook event (B10) of a connection an agent's trigger names. */
  async onWebhook(e: {
    id: string;
    tenantId: string;
    connectionId: string;
    type: string;
    data: unknown;
  }): Promise<void> {
    const found = await this.triggersOf(e.tenantId, 'webhook');
    for (const { agent, trigger } of found) {
      const t = AgentTrigger.safeParse(trigger.spec);
      if (
        !t.success ||
        t.data.kind !== 'webhook' ||
        !webhookMatches(t.data, e.connectionId, e.type)
      )
        continue;
      await this.start({
        agent,
        triggerId: trigger.id,
        kind: 'webhook',
        label: `on the webhook event ${e.type}`,
        input: { webhook: { id: e.id, type: e.type, data: e.data } },
        dedupe: `webhook:${e.id}`,
      });
    }
  }

  /* ── The clock ───────────────────────────────────────────────────────── */

  /**
   * Every 30 seconds (and in tests with a given `now`): due time triggers start their runs, due
   * conditions are checked, a queued run that lost its job gets one, a run whose worker died fails.
   */
  async tick(now = new Date()): Promise<{ fired: number; checked: number }> {
    let fired = 0;
    let checked = 0;
    for (;;) {
      // In one transaction: the due triggers move on and their runs are recorded, so a crash
      // loses neither; the runs are queued after it commits (and again by `recover`).
      const due = await this.db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(agentTriggers)
          .where(
            and(
              eq(agentTriggers.queues, config.queuePrefix),
              sql`${agentTriggers.nextAt} <= ${now.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(agentTriggers.nextAt)
          .limit(20)
          .for('update', { skipLocked: true });
        const owners = locked.length
          ? await tx
              .select()
              .from(agents)
              .where(
                inArray(
                  agents.id,
                  locked.map((t) => t.agentId),
                ),
              )
          : [];
        const rows = locked.flatMap((trigger) => {
          const agent = owners.find((a) => a.id === trigger.agentId);
          return agent ? [{ trigger, agent }] : [];
        });
        const runs: string[] = [];
        const conditions: { agent: AgentRow; trigger: TriggerRow; zone: string }[] = [];
        for (const { trigger, agent } of rows) {
          const spec = AgentTrigger.safeParse(trigger.spec);
          const zone = await this.zone(trigger.tenantId);
          const dueAt = trigger.nextAt as Date;
          await tx
            .update(agentTriggers)
            .set({ nextAt: spec.success ? nextDue(spec.data, zone, now) : null, lastFiredAt: now })
            .where(eq(agentTriggers.id, trigger.id));
          // A paused agent's time passes without a run: it does not fire everything when resumed.
          if (!spec.success || agent.status !== 'active') continue;
          if (spec.data.kind === 'condition') {
            conditions.push({ agent, trigger, zone });
            continue;
          }
          const id = await this.record(tx, {
            agent,
            triggerId: trigger.id,
            kind: spec.data.kind,
            label: triggerLabel(spec.data),
            input: { at: dueAt.toISOString() },
            dedupe: `time:${trigger.id}:${dueAt.toISOString()}`,
          });
          if (id) runs.push(id);
        }
        return { count: locked.length, runs, conditions };
      });
      for (const id of due.runs) await this.enqueue(id);
      fired += due.runs.length;
      for (const { agent, trigger, zone } of due.conditions) {
        const spec = AgentTrigger.parse(trigger.spec);
        if (spec.kind !== 'condition') continue;
        checked++;
        fired += await this.checkCondition(agent, trigger, spec, now, zone);
      }
      if (due.count < 20) break;
    }
    // Lost jobs and dead workers by the real clock: `now` may be a test's, far ahead.
    await this.recover(new Date());
    return { fired, checked };
  }

  /**
   * A condition, as the owner: each record of the entity that matches now and did not before
   * starts one run; a record that no longer matches may start one again later.
   */
  private async checkCondition(
    agent: AgentRow,
    trigger: TriggerRow,
    t: Extract<AgentTrigger, { kind: 'condition' }>,
    now: Date,
    zone: string,
  ): Promise<number> {
    const def = entityDef(t.entity);
    const owner = await this.ownerPrincipal(agent);
    if (!def || !owner) return 0;
    let items: Record<string, unknown>[];
    try {
      const input = { ...resolveWhere(t.where, now, zone), limit: 100 };
      const page = await def.repo.list(this.db, owner, input);
      items = page.items as Record<string, unknown>[];
    } catch (e) {
      log.warn(`agent=${agent.id} condition on ${t.entity}: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
    const ids = items.map((r) => String(r.id));
    const seen = await this.db
      .select({ recordId: agentConditionHits.recordId })
      .from(agentConditionHits)
      .where(eq(agentConditionHits.triggerId, trigger.id));
    const before = new Set(seen.map((s) => s.recordId));
    // Records that stopped matching are forgotten: they may start a run again later.
    const gone = [...before].filter((id) => !ids.includes(id));
    if (gone.length)
      await this.db
        .delete(agentConditionHits)
        .where(
          and(
            eq(agentConditionHits.triggerId, trigger.id),
            inArray(agentConditionHits.recordId, gone),
          ),
        );
    let started = 0;
    for (const row of items) {
      const id = String(row.id);
      if (before.has(id) || started >= CONDITION_RUNS) continue;
      const [hit] = await this.db
        .insert(agentConditionHits)
        .values({ triggerId: trigger.id, recordId: id })
        .onConflictDoNothing()
        .returning();
      if (!hit) continue;
      const run = await this.start({
        agent,
        triggerId: trigger.id,
        kind: 'condition',
        label: triggerLabel(t),
        input: { entity: t.entity, record: def.toRead(row as never, owner) },
        dedupe: `condition:${trigger.id}:${id}:${hit.seenAt.toISOString()}`,
      });
      if (run) started++;
    }
    return started;
  }

  /** Queued runs whose job was lost get one; runs whose worker died fail. */
  private async recover(now: Date) {
    const lost = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.queues, config.queuePrefix),
          eq(agentRuns.status, 'queued'),
          lt(agentRuns.updatedAt, new Date(now.getTime() - LOST_JOB_MS)),
        ),
      )
      .limit(50);
    for (const { id } of lost) await this.enqueue(id).catch(() => {});
    const dead = await this.db
      .update(agentRuns)
      .set({ status: 'failed', reason: 'The run stopped without finishing', finishedAt: now })
      .where(
        and(
          eq(agentRuns.queues, config.queuePrefix),
          eq(agentRuns.status, 'running'),
          lt(agentRuns.updatedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
        ),
      )
      .returning();
    for (const r of dead) await this.announce(r);
  }

  /* ── Budgets ─────────────────────────────────────────────────────────── */

  /** Why this agent may not run now (its budget is used up), or null. `except`: this run. */
  async budgetRefusal(
    agent: AgentRow,
    except?: string,
  ): Promise<{ rule: string; reason: string } | null> {
    const budget = (agent.budget ?? {}) as Partial<z.infer<typeof AgentBudget>>;
    if (!budget.runs && !budget.tokens && !budget.credits) return null;
    const zone = await this.zone(agent.tenantId);
    const unit = budget.period ?? 'month';
    const { rows } = await this.db.execute<{ start: Date | string }>(sql`
      select date_trunc(${unit}, now() at time zone ${zone}) at time zone ${zone} as start`);
    const start = new Date(rows[0].start);
    const mine = and(
      eq(agentRuns.agentId, agent.id),
      gte(agentRuns.createdAt, start),
      except ? sql`${agentRuns.id} <> ${except}` : undefined,
    );
    const [used] = await this.db
      .select({
        runs: sql<number>`count(*) filter (where ${agentRuns.status} in ('running', 'waiting', 'done', 'failed'))::int`,
        tokens: sql<number>`coalesce(sum(${agentRuns.inputTokens} + ${agentRuns.outputTokens}), 0)::int`,
      })
      .from(agentRuns)
      .where(mine);
    const exhausted = (what: string, n: number, of: number) => ({
      rule: 'agent_budget_exhausted',
      reason: `This agent has used ${n} of its ${of} ${what} this ${unit}`,
    });
    if (budget.runs && used.runs >= budget.runs) return exhausted('runs', used.runs, budget.runs);
    if (budget.tokens && used.tokens >= budget.tokens)
      return exhausted('tokens', used.tokens, budget.tokens);
    if (budget.credits) {
      const [spent] = await this.db
        .select({
          cost: sql<number>`coalesce(sum(${usageEvents.cost}), 0)::bigint`.mapWith(Number),
        })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.tenantId, agent.tenantId),
            gte(usageEvents.at, start),
            inArray(
              usageEvents.runId,
              this.db.select({ runId: agentRuns.runId }).from(agentRuns).where(mine),
            ),
          ),
        );
      if (spent.cost >= budget.credits) return exhausted('credits', spent.cost, budget.credits);
    }
    return null;
  }

  /* ── The run log ─────────────────────────────────────────────────────── */

  /** Store `agent.run.finished` (or `.waiting`) for a run that changed: live updates follow. */
  async announce(r: RunRow) {
    if (!['done', 'failed', 'refused', 'waiting'].includes(r.status)) return;
    const [agent] = await this.db
      .select({ ownerId: agents.ownerId })
      .from(agents)
      .where(eq(agents.id, r.agentId));
    if (!agent) return;
    const name = r.status === 'waiting' ? 'agent.run.waiting' : 'agent.run.finished';
    await this.db.transaction((tx) =>
      recordEvents(tx, {
        principal: systemPrincipal({ tenantId: r.tenantId, job: 'agents.run' }),
        requestId: `agent-run:${r.id}`,
        events: [
          new AgentRunEvent(name, {
            id: r.id,
            agentId: r.agentId,
            runId: r.runId,
            status: r.status,
            ownerId: agent.ownerId,
          }),
        ],
      }),
    );
  }

  /**
   * A run that waited went on (A7's `thread.continued`, with how): close it in the log. Refused
   * or failed as the event says; otherwise done, unless another request of the run still waits.
   */
  async onContinued(event: DomainEventEnvelope): Promise<string> {
    const row = event.row as { runId?: string; messageId?: string; outcome?: string } | null;
    if (!row?.runId) return 'no run';
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.runId, row.runId), eq(agentRuns.tenantId, event.tenantId)));
    if (!run) return 'not an agent run';
    const [message] = row.messageId
      ? await this.db
          .select({ text: threadMessages.text, parts: threadMessages.parts })
          .from(threadMessages)
          .where(eq(threadMessages.id, row.messageId))
      : [];
    const [pending] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(eq(approvals.runId, run.runId), eq(approvals.status, 'pending')));
    const reply = message?.text ?? null;
    const calls = summarizeParts((message?.parts ?? []) as SavedPart[]);
    const status: RunRow['status'] =
      row.outcome === 'refused'
        ? 'refused'
        : row.outcome === 'failed'
          ? 'failed'
          : pending.n > 0
            ? 'waiting'
            : 'done';
    const [updated] = await this.db
      .update(agentRuns)
      .set({
        status: run.status === 'refused' ? 'refused' : status,
        reason:
          run.status === 'refused' ? run.reason : status === 'done' ? null : (run.reason ?? reply),
        reply,
        toolCalls: [...((run.toolCalls as ToolCallSummary[]) ?? []), ...calls],
        finishedAt: status === 'waiting' ? null : new Date(),
      })
      .where(eq(agentRuns.id, run.id))
      .returning();
    await this.announce(updated);
    return updated.status;
  }

  /** May p see this agent's runs: its owner, or a manager of its business. */
  private mayRead(p: Principal, agent: { ownerId: string; tenantId: string }) {
    if (!p.tenantId || p.tenantId !== agent.tenantId) return false;
    if (p.scopes.includes('agent-run')) return false;
    if (can(p, AgentCapabilities.manage)) return true;
    const s = p.subject;
    return s?.kind === 'user' && s.userId === agent.ownerId;
  }

  /** The runs p may read, newest first: one agent's, or every agent's they may see. */
  async runs(p: Principal, q: z.infer<typeof AgentRunsQueryParsed>): Promise<AgentRunPage> {
    if (!p.tenantId) throw new NotFoundException({ error: 'not_found', message: 'No such agent' });
    const limit = q.limit ?? 50;
    if (q.agentId) {
      const [agent] = await this.db
        .select({ ownerId: agents.ownerId, tenantId: agents.tenantId })
        .from(agents)
        .where(and(eq(agents.id, q.agentId), eq(agents.tenantId, p.tenantId)));
      if (!agent || !this.mayRead(p, agent))
        throw new NotFoundException({ error: 'not_found', message: 'No such agent' });
    }
    const manager = can(p, AgentCapabilities.manage) && !p.scopes.includes('agent-run');
    const me = p.subject?.kind === 'user' ? p.subject.userId : '';
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await this.db
      .select({ run: agentRuns, ownerId: agents.ownerId })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(
        and(
          eq(agentRuns.tenantId, p.tenantId),
          q.agentId ? eq(agentRuns.agentId, q.agentId) : undefined,
          q.status ? eq(agentRuns.status, q.status) : undefined,
          manager ? undefined : eq(agents.ownerId, me),
          cursor
            ? or(
                lt(agentRuns.createdAt, cursor.at),
                and(eq(agentRuns.createdAt, cursor.at), lt(agentRuns.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(limit + 1);
    const items = rows
      .slice(0, limit)
      .map((r) => (r.ownerId === me ? toRun(r.run) : outline(toRun(r.run))));
    const last = rows.length > limit ? rows[limit - 1].run : undefined;
    return { items, nextCursor: last ? encodeCursor(last) : null };
  }

  /**
   * One run, with its messages, if p may read it; otherwise 404. A manager who is not the owner
   * gets its outline only: what the run said and read is as its owner sees the records.
   */
  async run(p: Principal, id: string): Promise<AgentRunDetail> {
    const row = await this.runFor(p, id);
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such run' });
    if (!this.owns(p, row)) return { ...outline(toRun(row)), messages: [] };
    const messages = await this.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.runId, row.runId))
      .orderBy(threadMessages.seq);
    return { ...toRun(row), messages: messages.map(toMessage) };
  }

  /** Is p the owner of this run's agent? */
  private owns(p: Principal, run: RunRow & { ownerId?: string }) {
    return p.subject?.kind === 'user' && p.subject.userId === run.ownerId;
  }

  /** The run (with its agent's owner), if p may read it. */
  async runFor(p: Principal, id: string): Promise<(RunRow & { ownerId: string }) | undefined> {
    if (!p.tenantId || !UUID.test(id)) return undefined;
    const [row] = await this.db
      .select({ run: agentRuns, ownerId: agents.ownerId })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(and(eq(agentRuns.id, id), eq(agentRuns.tenantId, p.tenantId)));
    if (!row || !this.mayRead(p, { ownerId: row.ownerId, tenantId: row.run.tenantId }))
      return undefined;
    return { ...row.run, ownerId: row.ownerId };
  }

  /** The application's templates, in the reader's language, and whether each can be made here. */
  templates(lang: Lang): AgentTemplateInfo[] {
    const { catalog } = runtime();
    let tools: Set<string> | undefined;
    return agentTemplates.all().map((t) => {
      tools ??= new Set(allToolIds());
      const triggers = Triggers.parse(t.triggers);
      const available =
        t.scope.tools.every((x) => tools?.has(x)) &&
        triggers.every((x) => x.kind !== 'condition' || !!catalog.entityByName(x.entity));
      return {
        key: t.key,
        name: pick(t.name, lang),
        description: pick(t.description, lang),
        instructions: t.instructions,
        triggers,
        scope: t.scope,
        budget: AgentBudget.parse(t.budget ?? {}),
        available,
      };
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET /api/agent-runs`'s query, parsed. */
export const AgentRunsQueryParsed = AgentRunsQuery;

function encodeCursor(r: RunRow) {
  return Buffer.from(JSON.stringify([r.createdAt.toISOString(), r.id])).toString('base64url');
}
function decodeCursor(c: string): { at: Date; id: string } | undefined {
  try {
    const [at, id] = JSON.parse(Buffer.from(c, 'base64url').toString()) as [string, string];
    const d = new Date(at);
    return Number.isNaN(d.getTime()) || typeof id !== 'string' ? undefined : { at: d, id };
  } catch {
    return undefined;
  }
}

/**
 * A run as a manager who is not its owner sees it: what started it, how it went, why it was refused
 * or failed, and what it used, but not its reply, its messages or what its tool calls showed. Those
 * carry the records as the owner reads them, and a manager may not read the same.
 */
function outline(r: AgentRun): AgentRun {
  return {
    ...r,
    reply: null,
    toolCalls: r.toolCalls.map(({ tool, ok, outcome }) => ({ tool, ok, outcome })),
  };
}

/** A saved message as the app reads one (the threads service's shape). */
function toMessage(r: typeof threadMessages.$inferSelect): ThreadMessage {
  return {
    id: r.id,
    role: r.role,
    parts: [
      ...(r.role === 'assistant' ? (r.parts as SavedPart[]) : []),
      ...(r.text ? [{ type: 'text', text: r.text }] : []),
    ],
    metadata: {
      runId: r.runId,
      channel: r.channel,
      lang: r.lang,
      createdAt: r.createdAt.toISOString(),
    },
  };
}

/**
 * A saved continuation's tool parts, summarized as the chat does a turn's calls. A call whose
 * input the tool refused is saved `ok: false`; one saved before that was marked has no `ok` and
 * an error, and reads refused too.
 */
export function summarizeParts(parts: readonly SavedPart[]): ToolCallSummary[] {
  return parts
    .filter((p) => p.type.startsWith('tool-'))
    .map((p) => {
      const out = (p.output ?? {}) as {
        ok?: boolean;
        result?: { status?: string; approval?: { id?: string; summary?: string | null } };
        error?: { reason?: string };
      };
      const tool = p.type.slice(5);
      if (out.ok === false || (out.ok === undefined && out.error))
        return {
          tool,
          ok: false,
          outcome: 'refused' as const,
          ...(out.error?.reason ? { detail: out.error.reason } : {}),
        };
      if (out.result?.status === 'needs_approval')
        return {
          tool,
          ok: true,
          outcome: 'parked' as const,
          ...(out.result.approval?.summary ? { detail: out.result.approval.summary } : {}),
          ...(out.result.approval?.id ? { approvalId: out.result.approval.id } : {}),
        };
      return { tool, ok: true, outcome: 'done' as const };
    });
}
