import { drawsComponents, type Surface } from '@app/contracts';
import { mastra } from './mastra/index.js';
import type { Profile } from './tools/index.js';

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

/** The agent for a turn's surfaces: canvas tools only where a canvas can show them. */
export function agentFor(surfaces: readonly Surface[]) {
  return mastra.getAgent(AGENT_KEYS[profileFor(surfaces)]);
}
