// One run of an agent, in the worker: checked, gated as a turn, run as the assistant with the
// agent's instructions and only its scope's tools, its tools calling the API with the run's
// token, and logged. docs/decisions/A6.md.
import { createHash } from 'node:crypto';
import { runMessage } from '@hykr/agents';
import { AgentBudget, AgentScope } from '@hykr/contracts';
import { type Database, schema } from '@hykr/db';
import { RequestContext } from '@mastra/core/request-context';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { TurnInfo, TurnOutcome } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { summarize } from '../../modules/chat/chat.service.js';
import { afterTurn, gateTurn, TurnRefused } from '../../modules/chat/turn-hooks.js';
import { ThreadsService } from '../../modules/threads/threads.service.js';
import { runtime } from '../../runtime.js';
import { partsOf } from '../resume/parts.js';
import { type AgentRow, AgentsService, type RunRow } from './agents.service.js';
import { toolsOutside } from './scope.js';

const { agents, agentRuns } = schema;

const log = new Logger('AgentRun');

/** Saved in place of a reply that failed, as the chat service does. */
const INTERRUPTED = '(The reply was interrupted.)';

/** `agent:<id>@<model>#<hash>`: the agent, its model, and a hash of everything it was told. */
export function agentVersionOf(agent: AgentRow, model: string, assistantVersion: string): string {
  const scope = AgentScope.safeParse(agent.scope);
  const budget = AgentBudget.safeParse(agent.budget ?? {});
  const hash = createHash('sha256')
    .update(
      [
        assistantVersion,
        agent.instructions,
        JSON.stringify(scope.success ? scope.data.tools : []),
        String(budget.success ? budget.data.maxSteps : 6),
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 8);
  return `agent:${agent.id}@${model}#${hash}`;
}

@Injectable()
export class AgentRunner {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly threads: ThreadsService,
    private readonly svc: AgentsService,
  ) {}

  private async set(id: string, values: Partial<RunRow>): Promise<RunRow> {
    const [row] = await this.db
      .update(agentRuns)
      .set(values)
      .where(eq(agentRuns.id, id))
      .returning();
    return row;
  }

  /** The run ends before it starts: why. */
  private async refuse(id: string, rule: string, reason: string) {
    log.log(`agent run ${id} refused: ${rule}`);
    const row = await this.set(id, {
      status: 'refused',
      reason: `${rule}: ${reason}`,
      finishedAt: new Date(),
    });
    await this.svc.announce(row);
    return `refused: ${rule}`;
  }

  /** Run one queued run. Returns what happened, for the job's log. */
  async run(id: string): Promise<string> {
    const [started] = await this.db
      .update(agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(agentRuns.id, id), eq(agentRuns.status, 'queued')))
      .returning();
    if (!started) return 'not queued';
    const [agent] = await this.db.select().from(agents).where(eq(agents.id, started.agentId));
    if (!agent) return 'no agent';
    if (agent.status !== 'active') return this.refuse(id, 'agent_paused', 'The agent is paused');
    const owner = await this.svc.ownerPrincipal(agent, started.runId);
    if (!owner)
      return this.refuse(id, 'owner_not_member', "The agent's owner is no longer in the business");
    const over = await this.svc.budgetRefusal(agent, id);
    if (over) return this.refuse(id, over.rule, over.reason);

    const runId = started.runId;
    const scope = AgentScope.safeParse(agent.scope);
    const budget = AgentBudget.safeParse(agent.budget ?? {});
    const tools = scope.success ? scope.data.tools : [];
    const message = runMessage({
      instructions: agent.instructions,
      agentName: agent.name,
      label: started.triggerLabel,
      data: started.input ?? undefined,
    });
    const thread = await this.threads.agentThread(
      { tenantId: agent.tenantId, subject: { kind: 'user', userId: agent.ownerId } },
      agent.id,
      agent.name,
    );
    const info: TurnInfo = {
      kind: 'agent',
      principal: owner,
      runId,
      threadId: thread.id,
      message,
      channel: 'background',
      surfaces: ['text'],
    };
    let shape: Awaited<ReturnType<typeof gateTurn>>;
    try {
      shape = await gateTurn(info);
    } catch (e) {
      if (e instanceof TurnRefused) return this.refuse(id, e.refusal.rule, e.refusal.reason);
      throw e;
    }

    const zone = await this.svc.zone(agent.tenantId);
    const requestContext = new RequestContext();
    requestContext.set('actingFor', `user:${agent.ownerId}`);
    requestContext.set('tenantId', agent.tenantId);
    requestContext.set('userId', agent.ownerId);
    requestContext.set('runId', runId);
    requestContext.set('channel', 'background');
    // The tools' calls carry the run's token (agentRunToken), not the assistant's key.
    requestContext.set('agent', agent.id);
    requestContext.set('timeZone', zone);
    requestContext.set('today', new Date().toLocaleDateString('sv', { timeZone: zone }));
    requestContext.set('surfaces', ['text']);
    if (shape.context.length) requestContext.set('turnContext', shape.context);
    if (shape.model) requestContext.set('model', shape.model);
    requestContext.set('withoutTools', [
      ...new Set([...toolsOutside(tools), ...shape.withoutTools]),
    ]);

    const agentsRt = runtime().agents;
    const version = agentVersionOf(agent, shape.model, agentsRt.version({ requestContext }));
    await this.set(id, { model: shape.model, agentVersion: version, threadId: thread.id });
    await this.threads.append({
      threadId: thread.id,
      role: 'user',
      text: message,
      channel: 'background',
      runId,
    });

    const started_ = Date.now();
    let text: string;
    let results: unknown[];
    let usage: TurnOutcome['usage'];
    try {
      const result = await agentsRt
        .agentFor(['text'])
        .generate([{ role: 'user' as const, content: message }], {
          requestContext,
          maxSteps: budget.success ? budget.data.maxSteps : 6,
          tracingOptions: {
            traceId: runId,
            metadata: { subject: `user:${agent.ownerId}`, channel: 'background', agent: agent.id },
          },
        });
      text = result.text;
      results = (result.toolResults ?? []) as unknown[];
      usage = result.totalUsage
        ? {
            inputTokens: result.totalUsage.inputTokens,
            outputTokens: result.totalUsage.outputTokens,
            totalTokens: result.totalUsage.totalTokens,
          }
        : undefined;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn(`run=${runId} agent=${agent.id} failed: ${reason}`);
      await this.threads
        .append({
          threadId: thread.id,
          role: 'assistant',
          text: INTERRUPTED,
          channel: 'background',
          runId,
        })
        .catch(() => {});
      await afterTurn(info, { text: INTERRUPTED, toolCalls: [], interrupted: true });
      const row = await this.set(id, {
        status: 'failed',
        reason: reason.slice(0, 500),
        finishedAt: new Date(),
      });
      await this.svc.announce(row);
      return 'failed';
    }
    await this.threads.append({
      threadId: thread.id,
      role: 'assistant',
      text,
      parts: partsOf(results),
      channel: 'background',
      runId,
    });
    const calls = summarize(results);
    const waiting = calls.some((c) => c.outcome === 'parked');
    const row = await this.set(id, {
      status: waiting ? 'waiting' : 'done',
      reply: text,
      toolCalls: calls,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(waiting ? {} : { finishedAt: new Date() }),
    });
    await afterTurn(info, {
      text,
      toolCalls: calls.map((c) => c.tool),
      ...(usage ? { usage } : {}),
      interrupted: false,
    });
    await this.svc.announce(row);
    log.log(
      `run=${runId} agent=${agent.id} ${row.status} tools=[${calls.map((c) => `${c.tool}:${c.outcome}`).join(',')}] ${Date.now() - started_}ms`,
    );
    return row.status;
  }
}
