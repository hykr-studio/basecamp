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
  /**
   * The tools, keyed by tool id, for one run. Only build them here: call `kit.clientFor(ctx)` inside
   * a tool's `execute`, because the start builds every tool once to check the ids.
   */
  tools(kit: ToolKit): ToolsInput;
}

/**
 * Contributed tools, in registration order. The agent gets them on every turn, after the
 * generated tools; an id that is already taken stops the start (ChatService builds the whole set
 * once when the app starts).
 */
export const toolContributions = createHookRegistry<ToolContribution>(
  'tool contribution',
  (x) => x.name,
  { collects: 'toolContributions' },
);
