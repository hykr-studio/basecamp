import { createHookRegistry } from '@hykr/contracts';
import type { ToolsInput } from '@mastra/core/agent';
import type { ToolKit } from './tool-factory.js';

declare module '@hykr/contracts' {
  interface Contributions {
    toolContributions: readonly ToolContribution[];
  }
}

/**
 * Agent tools beyond the generated entity and command tools (recall memory, summarize). Like
 * every tool, they reach data only through the API, with the run's client from the kit.
 */
export interface ToolContribution {
  /** Unique: 'memory'. */
  name: string;
  /** The tools, keyed by tool id, for one run. */
  tools(kit: ToolKit): ToolsInput;
}

/** Contributed tools, in registration order. Nothing adds them to the agent yet. */
export const toolContributions = createHookRegistry<ToolContribution>(
  'tool contribution',
  (x) => x.name,
  { collects: 'toolContributions' },
);
