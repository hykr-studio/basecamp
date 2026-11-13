// How the agents feature plugs into the server's registries: the run token's identity, the turn
// hook for resumed runs, the inbound hook for WhatsApp messages, the `agent` mention kind, live
// checks, and personal data. Each reaches the running AgentsService through its slot.
import { AgentScope, AgentTrigger, type Principal } from '@hykr/contracts';
import type { AgentIdentityProvider, Tx } from '@hykr/core';
import { schema } from '@hykr/db';
import { Logger } from '@nestjs/common';
import { and, eq, exists, ilike, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ErasureContributor, ExportContributor, InboundHook, TurnHook } from '../../hooks.js';
import { both, createdBy } from '../../privacy/contributors.js';
import type { MentionContext, MentionKind } from '../comments/mention-kinds.js';
import type { LiveResource } from '../live/resources.js';
import { agentsService } from './agents.service.js';
import { toolsOutside } from './scope.js';

const { agents, agentRuns, approvals, threadMessages } = schema;
const log = new Logger('Agents');

/** A run's token, at the door (`x-agent-run` with `x-run-id`). */
export const AgentRunIdentity: AgentIdentityProvider = {
  name: 'agent-run',
  identify: async (req) => (await agentsService()?.identify(req)) ?? null,
};

/**
 * A resumed run that is one of the agents' (A7 resumes it): checked again (the agent active, its
 * budget), given only its scope's tools, and metered into its log. It is `running` while it
 * resumes, and `waiting` again after when another of its approvals is still pending.
 */
export const AgentsTurnHook: TurnHook = {
  name: 'agents',
  before: async (turn) => {
    const svc = agentsService();
    if (!svc || turn.kind !== 'resume') return null;
    const db = svc.database;
    const [row] = await db
      .select({ run: agentRuns, agent: agents })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(eq(agentRuns.runId, turn.runId));
    if (!row) return null;
    const refuse = async (rule: string, reason: string) => {
      await db
        .update(agentRuns)
        .set({ status: 'refused', reason: `${rule}: ${reason}`, finishedAt: new Date() })
        .where(eq(agentRuns.id, row.run.id));
      return { refuse: { rule, reason } };
    };
    if (row.agent.status !== 'active') return refuse('agent_paused', 'The agent is paused');
    const over = await svc.budgetRefusal(row.agent, row.run.id);
    if (over) return refuse(over.rule, over.reason);
    await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, row.run.id));
    const scope = AgentScope.safeParse(row.agent.scope);
    return { withoutTools: toolsOutside(scope.success ? scope.data.tools : []) };
  },
  after: async (turn, outcome) => {
    const svc = agentsService();
    if (!svc || turn.kind !== 'resume') return;
    const db = svc.database;
    const lost = (what: string) => (e: unknown) =>
      log.warn(`run=${turn.runId}: ${what} not kept: ${(e as Error).message}`);
    if (outcome.usage)
      await db
        .update(agentRuns)
        .set({
          inputTokens: sql`${agentRuns.inputTokens} + ${outcome.usage.inputTokens ?? 0}`,
          outputTokens: sql`${agentRuns.outputTokens} + ${outcome.usage.outputTokens ?? 0}`,
        })
        .where(eq(agentRuns.runId, turn.runId))
        .catch(lost('usage'));
    // A resume that leaves the run waiting for another of its approvals: waiting again, not
    // running. When it said nothing new, no `thread.continued` comes to close it, and a run left
    // `running` would hold one of the agent's open runs and be failed as stale.
    await db
      .update(agentRuns)
      .set({ status: 'waiting' })
      .where(
        and(
          eq(agentRuns.runId, turn.runId),
          eq(agentRuns.status, 'running'),
          exists(
            db
              .select({ one: sql`1` })
              .from(approvals)
              .where(and(eq(approvals.runId, turn.runId), eq(approvals.status, 'pending'))),
          ),
        ),
      )
      .catch(lost('status'));
  },
};

/** Each WhatsApp message the code did not answer itself: agents with a `message` trigger run. */
export const AgentsInbound: InboundHook = {
  name: 'agents',
  onMessage: async (msg) => {
    await agentsService()?.onInbound(msg);
    return null;
  },
};

const Triggers = z.array(AgentTrigger);

/** The agents a comment may name: active, with a mention trigger, whose owner may read the record. */
async function mentionable(a: MentionContext, where: ReturnType<typeof and>, limit: number) {
  const svc = agentsService();
  if (!svc) return [];
  const rows = await a.conn
    .select()
    .from(agents)
    .where(and(eq(agents.tenantId, a.tenantId), eq(agents.status, 'active'), where))
    .orderBy(agents.name)
    .limit(limit);
  const out: { id: string; label: string }[] = [];
  for (const agent of rows) {
    if (!Triggers.safeParse(agent.triggers).data?.some((t) => t.kind === 'mention')) continue;
    const owner = await svc.ownerPrincipal(agent);
    if (owner && (await svc.mayBeMentioned(owner, a.on, a.internal)))
      out.push({ id: agent.id, label: agent.name });
  }
  return out;
}

/** `@[Name](agent:<id>)` in a comment: the business's agents that listen for mentions. */
export const AgentMentions: MentionKind = {
  kind: 'agent',
  resolve: async (a) => {
    const ids = a.ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return new Map();
    const found = await mentionable(a, inArray(agents.id, ids), ids.length);
    return new Map(found.map((f) => [f.id, f.label]));
  },
  suggest: async (a) => {
    const q = a.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    return (await mentionable(a, q ? ilike(agents.name, `%${q}%`) : undefined, 50)).slice(
      0,
      a.limit,
    );
  },
};

/** `agent.run.*` events reach the agent's owner and the business's managers. */
export const AgentRunLive: LiveResource = {
  type: 'agent_run',
  visible: async (p: Principal, id: string) => !!(await agentsService()?.runFor(p, id)),
};

const ownedBy = (tx: Tx, userId: string, tenantId?: string) =>
  tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, userId), tenantId ? eq(agents.tenantId, tenantId) : undefined));

/** What an agent's copies hold that its owner wrote (audit rows, `agent.*` events, replies). */
const AGENT_WORDS = ['name', 'description', 'instructions', 'triggers'];
/** What a run's copies hold of what started it and what it said. */
const RUN_WORDS = ['input', 'reply', 'reason', 'triggerLabel', 'trigger', 'toolCalls', 'messages'];

/** Runs of this business's agents that a contact's message started (`input.message.from`). */
const startedBy = (tx: Tx, contactId: string, tenantId?: string) =>
  tx
    .select({ id: agentRuns.id, runId: agentRuns.runId, threadId: agentRuns.threadId })
    .from(agentRuns)
    .where(
      and(
        sql`${agentRuns.input} -> 'message' -> 'from' ->> 'contactId' = ${contactId}`,
        tenantId ? eq(agentRuns.tenantId, tenantId) : undefined,
      ),
    );

/**
 * Erasing a person deletes the agents they own: their triggers, runs and thread go with them,
 * and the copies of the agents and runs lose what the person wrote and the runs said. Erasing a
 * contact keeps the runs their messages started (another person's agent did the work), without
 * the message, the reply and the run's turns in the agent's thread; the runs' Mastra rows go
 * with the contact's own.
 */
export const AgentsErasure: ErasureContributor = {
  name: 'agents',
  erase: async ({ tx, subject, tenantId }) => {
    if (subject.kind === 'contact') {
      const runs = await startedBy(tx, subject.contactId, tenantId);
      if (!runs.length) return { count: 0 };
      const ids = runs.map((r) => r.id);
      await tx
        .update(agentRuns)
        .set({ input: null, reply: null })
        .where(inArray(agentRuns.id, ids));
      await tx.delete(threadMessages).where(
        inArray(
          threadMessages.runId,
          runs.map((r) => r.runId),
        ),
      );
      return {
        count: runs.length,
        erased: [{ type: 'agent_run', ids, fields: RUN_WORDS }],
        runs: runs.map((r) => r.runId),
      };
    }
    const mine = await ownedBy(tx, subject.userId, tenantId);
    // With those they deleted before: their copies stay otherwise.
    const made = await createdBy(tx, { type: 'agent', userId: subject.userId, tenantId });
    if (!mine.length && !made.length) return { count: 0 };
    const agentIds = mine.map((m) => m.id);
    // Read before the cascade takes them.
    const runs = agentIds.length
      ? await tx
          .select({ id: agentRuns.id, runId: agentRuns.runId })
          .from(agentRuns)
          .where(inArray(agentRuns.agentId, agentIds))
      : [];
    if (agentIds.length) await tx.delete(agents).where(inArray(agents.id, agentIds));
    return {
      count: mine.length,
      erased: [
        { type: 'agent', ids: both(agentIds, made), fields: AGENT_WORDS, deleted: true },
        { type: 'agent_run', ids: runs.map((r) => r.id), fields: RUN_WORDS, deleted: true },
      ],
      runs: runs.map((r) => r.runId),
    };
  },
};

/** A person's agents and what their runs did. */
export const AgentsExport: ExportContributor = {
  name: 'agents',
  export: async ({ db, subject, tenantId }): Promise<Record<string, readonly unknown[]>> => {
    if (subject.kind !== 'user') return {};
    const mine = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.ownerId, subject.userId),
          tenantId ? eq(agents.tenantId, tenantId) : undefined,
        ),
      );
    if (!mine.length) return {};
    const runs = await db
      .select({
        agentId: agentRuns.agentId,
        trigger: agentRuns.triggerLabel,
        status: agentRuns.status,
        reply: agentRuns.reply,
        at: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(
        inArray(
          agentRuns.agentId,
          mine.map((m) => m.id),
        ),
      );
    return {
      agents: mine.map((m) => ({
        id: m.id,
        tenantId: m.tenantId,
        name: m.name,
        instructions: m.instructions,
        triggers: m.triggers,
        scope: m.scope,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
      agentRuns: runs.map((r) => ({ ...r, at: r.at.toISOString() })),
    };
  },
};
