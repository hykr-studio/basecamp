import { type Catalog, drawsComponents, type Surface } from '@hykr/contracts';
import type { ResumeDecision } from '@hykr/core/tools';
import type { Registry } from '@hykr/ui-registry';
import type { Agent } from '@mastra/core/agent';
import type { AgentDomain } from './agent-domain.js';
import { createAssistant, versionModel } from './assistant.js';
import { createApiFor } from './context.js';
import { durableAgent, findSuspension, resumeSuspension, type Suspension } from './durable.js';
import { createMastra } from './mastra/index.js';
import type { Profile } from './tools/index.js';
import { agentVersion, buildInstructions } from './version.js';

/** The Mastra registration name for each tool profile. */
export const AGENT_KEYS = {
  app: 'assistant',
  inline: 'assistantInline',
  text: 'assistantText',
} as const satisfies Record<Profile, string>;

export function profileFor(surfaces: readonly Surface[]): Profile {
  if (surfaces.includes('canvas')) return 'app';
  return drawsComponents(surfaces) ? 'inline' : 'text';
}

/**
 * The application's assistant: the framework's instructions, tools, scripted model and scorers
 * over the application's catalog, views and agent domain. One per process (the API, the
 * worker, Studio and the evals each build theirs from the same inputs).
 */
export function createAgents(input: { catalog: Catalog; registry: Registry; domain: AgentDomain }) {
  const { catalog, registry, domain } = input;
  const instructions = buildInstructions(domain);
  // Per call: the model part names the model this turn runs on (the scripted one in fake mode).
  const version = (ctx?: { requestContext?: { get(key: string): unknown } }) =>
    agentVersion(instructions, versionModel(ctx ?? {}));
  const kit = { clientFor: createApiFor(version), registry };
  const assistant = (profile: Profile) =>
    createAssistant({ profile, instructions, domain, catalog, kit });
  const mastra = createMastra({
    // One assistant, one tool set per surface profile.
    agents: {
      assistant: assistant('app'),
      assistantInline: assistant('inline'),
      assistantText: assistant('text'),
    },
    commands: catalog.commands,
  });
  const registered = (): Record<string, Agent> =>
    Object.fromEntries(Object.values(AGENT_KEYS).map((key) => [key, mastra.getAgent(key)]));
  return {
    mastra,
    catalog,
    domain,
    version,
    /**
     * The agent for a turn's surfaces: canvas tools only where a canvas can show them. Durable: a
     * write that waits for approval suspends the run, and the turn answers as a parked one.
     */
    agentFor: (surfaces: readonly Surface[]) =>
      durableAgent(mastra.getAgent(AGENT_KEYS[profileFor(surfaces)])),
    /** The run, if it is suspended waiting for this approval (from Mastra's storage). */
    findSuspension: (a: { runId: string; approvalId: string }) =>
      findSuspension(mastra, registered(), a),
    /** Resume a suspended run with its approval's decision; it carries on under its run id. */
    resume: (
      s: Suspension,
      decision: ResumeDecision,
      options: { requestContext: { get(key: string): unknown }; maxSteps?: number; text?: string },
    ) => {
      const agent = registered()[s.agent];
      if (!agent) throw new Error(`No agent ${s.agent} to resume run ${s.runId}`);
      return resumeSuspension(agent, s, decision, options);
    },
  };
}

export type Agents = ReturnType<typeof createAgents>;
