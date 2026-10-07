import { PageSpec, type Present, ViewQuery } from '@app/contracts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { resolvePresent } from './present.js';
import type { ToolContext, ToolKit } from './tool-factory.js';

/**
 * The canvas tools: the assistant shows things beside the chat. They only exist on turns
 * whose surfaces include the canvas (see agentFor). Each returns a present intent checked
 * against the registry; a bad screen, view or query is an error the model sees and fixes,
 * never something a client has to guard against.
 */
async function intent(present: Present, ctx: ToolContext | undefined, kit: ToolKit) {
  const resolved = await resolvePresent(present, ctx, kit);
  if ('error' in resolved) return { ok: false as const, error: { reason: resolved.error } };
  if (!resolved.present)
    return { ok: false as const, error: { reason: 'There is no canvas on this screen' } };
  return { ok: true as const, result: { shown: true }, present: resolved.present };
}

export function canvasTools(kit: ToolKit) {
  const { screens, catalog } = kit.registry;
  const screenList = screens.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  const names = screens.map((s) => s.name) as [string, ...string[]];

  return {
    'canvas-open': createTool({
      id: 'canvas-open',
      description: `Open one of the person's own screens beside the chat, by id: find the id first with a list tool. Screens:\n${screenList}`,
      inputSchema: z.object({
        screen: z.enum(names),
        params: z.object({ id: z.string() }).describe('The record id'),
      }),
      execute: async ({ screen, params }, ctx) =>
        intent({ kind: 'open', screen, params }, ctx, kit),
    }),

    'canvas-compose': createTool({
      id: 'canvas-compose',
      description: `Compose a page beside the chat when the person wants an overview that needs more than one list ("plan my week", "what should I focus on"). Keep it to 2–4 blocks, each with a clear props.title. Blocks hold queries, not data: the app fetches each one with the person's session. Layout "two-column" puts half-width blocks side by side; span "full" takes the row. Views for pages:\n${catalog('canvas')}`,
      inputSchema: PageSpec,
      execute: async (page, ctx) => intent({ kind: 'page', page }, ctx, kit),
    }),

    'canvas-patch': createTool({
      id: 'canvas-patch',
      description:
        'Change one block of the page on the canvas ("only the overdue ones", "add next week too") instead of composing a new page. The query replaces the block\'s query; props are merged. The current page and its block ids are in your instructions.',
      inputSchema: z.object({
        blockId: z.string(),
        query: ViewQuery.optional(),
        props: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (patch, ctx) => intent({ kind: 'patch', ...patch }, ctx, kit),
    }),
  };
}
