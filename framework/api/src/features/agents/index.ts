// Agents a business makes (A6): definitions (the `agent` entity), triggers (once, recurring,
// event, condition, inbound message, @-mention, webhook), runs on the `agents.run` queue acting
// for their owner with a run token, budgets, and the run log. docs/decisions/A6.md.
import { AgentCapabilities, reserveRoutes } from '@hykr/contracts';
import { commandController, commandHandler, entityController, entityHandlers } from '@hykr/core';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ThreadsModule } from '../../modules/threads/threads.module.js';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
// Their registries first: installing the contributions needs their collectors.
import '../comments/mention-kinds.js';
import '../integrations/registry.js';
import '../live/resources.js';
import { Agent, AgentAccess } from './agent.entity.js';
import { AgentsService, RUN_QUEUE } from './agents.service.js';
import { AgentDefinitions } from './definitions.js';
import {
  AgentMentions,
  AgentRunIdentity,
  AgentRunLive,
  AgentsErasure,
  AgentsExport,
  AgentsInbound,
  AgentsTurnHook,
  agentRunCopies,
} from './hooks.js';
import { RunAgent } from './run-command.js';
import { AgentRunner } from './runner.js';
import { AgentRunsController, AgentTemplatesController } from './runs.controller.js';
import { AgentScopeHook, AgentScopeInterceptor } from './scope.js';
import { agentWebhookHandler, agentWebhooks } from './templates.js';

// The run log and the templates (/api/agents is the entity's own plural).
reserveRoutes('agent-runs', 'agent-templates');

/** One run each: a failed run is logged as failed, not tried again. */
export const AgentRunQueue = defineQueue<{ id: string }, string>({
  name: RUN_QUEUE,
  concurrency: 4,
  process: (job, ctx) => ctx.get(AgentRunner).run(job.data.id),
});

/** The clock: due time triggers and conditions, lost jobs, dead runs. */
export const AgentTickQueue = defineQueue<unknown, unknown>({
  name: 'agents.tick',
  process: (_job, ctx) => ctx.get(AgentsService).tick(),
});

export const AgentTick = defineSchedule({
  name: 'agents.tick',
  queue: AgentTickQueue.name,
  every: 30_000,
});

/** Events the agents make themselves, which start no event trigger. */
const OWN = new Set(['agent.run.requested', 'thread.continued']);

/** Every stored event: agents with a matching event trigger run. */
export const AgentEvents = defineSubscriber({
  name: 'agents.events',
  on: ['*'],
  when: (e) => !OWN.has(e.name),
  handle: async (event, ctx) => {
    await ctx.get(AgentsService).onEvent(event);
  },
});

/** An @-mention of an agent in a comment. */
export const AgentMentioned = defineSubscriber({
  name: 'agents.mentions',
  on: ['comment.mentioned'],
  when: (e) => (e.row as { target?: { kind?: string } } | null)?.target?.kind === 'agent',
  handle: async (event, ctx) => {
    await ctx.get(AgentsService).onMention(event);
  },
});

/** Run now: the command stored the queued run; queue it. */
export const AgentRequested = defineSubscriber({
  name: 'agents.requested',
  on: ['agent.run.requested'],
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(AgentsService).enqueue(event.resourceId);
  },
});

/** A run that waited for an approval went on (A7): close it in the log. */
export const AgentContinued = defineSubscriber({
  name: 'agents.continued',
  on: ['thread.continued'],
  handle: async (event, ctx) => {
    await ctx.get(AgentsService).onContinued(event);
  },
});

export const agentsFeature = defineFeature({
  name: 'agents',
  imports: [ThreadsModule],
  controllers: [
    entityController(Agent),
    commandController(RunAgent),
    AgentRunsController,
    AgentTemplatesController,
  ],
  providers: [
    ...entityHandlers(Agent),
    commandHandler(RunAgent),
    AgentsService,
    AgentRunner,
    { provide: APP_INTERCEPTOR, useClass: AgentScopeInterceptor },
  ],
  exports: [AgentsService, AgentRunner],
  contributes: {
    capabilities: [AgentCapabilities.create, AgentCapabilities.manage],
    entityPlugins: [AgentAccess],
    writeHooks: [AgentScopeHook, AgentDefinitions],
    identityProviders: [AgentRunIdentity],
    turnHooks: [AgentsTurnHook],
    inboundHooks: [AgentsInbound],
    mentionKinds: [AgentMentions],
    liveResources: [AgentRunLive],
    connectors: [agentWebhooks],
    connectorHandlers: [agentWebhookHandler(agentWebhooks.name)],
    queues: [AgentRunQueue, AgentTickQueue],
    schedules: [AgentTick],
    subscribers: [AgentEvents, AgentMentioned, AgentRequested, AgentContinued],
    erasureContributors: [AgentsErasure],
    recordCopies: [agentRunCopies],
    exportContributors: [AgentsExport],
  },
});

export * from './public.js';
