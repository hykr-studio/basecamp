import { type Catalog, drawsComponents, type Surface } from '@hykr/contracts';
import type { Registry } from '@hykr/ui-registry';
import type { AgentDomain } from './agent-domain.js';
import { createAssistant } from './assistant.js';
import { createApiFor } from './context.js';
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
  // Read per call: MODEL_MODE decides the model's part of the version.
  const version = () => agentVersion(instructions);
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
  return {
    mastra,
    catalog,
    domain,
    version,
    /** The agent for a turn's surfaces: canvas tools only where a canvas can show them. */
    agentFor: (surfaces: readonly Surface[]) => mastra.getAgent(AGENT_KEYS[profileFor(surfaces)]),
  };
}

export type Agents = ReturnType<typeof createAgents>;
