import { FreeTimeQuery, SendInviteSpec } from '@hykr/contracts';
import { commandTools, safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * The assistant's calendar tools, calling the API as the agent for the person: invites (a send
 * to anyone else waits for the person's approval), a record's invites, and free time from the
 * person's connected calendar.
 */
export const calendarTools: ToolContribution = {
  name: 'calendar',
  tools: (kit) => ({
    ...commandTools([SendInviteSpec], kit),
    'find-free-time': createTool({
      id: 'find-free-time',
      description:
        "Free slots in the user's connected calendar (or, if they may, a colleague's): give the window, how long each slot is, and optionally working hours. Busy times come from the calendar; nothing about other events is shown. Says connected: false when no calendar is connected.",
      inputSchema: FreeTimeQuery,
      execute: async (query, ctx) =>
        safely('find-free-time', ctx, kit, () => kit.clientFor(ctx).calendar.free(query)),
    }),
    'list-invites': createTool({
      id: 'list-invites',
      description: "A record's calendar invites: who was invited, and whether each one went out.",
      inputSchema: z.object({
        entity: z.string().min(1).describe("The record's kind (an entity name)"),
        id: z.string().min(1).describe("The record's id"),
      }),
      execute: async ({ entity, id }, ctx) =>
        safely('list-invites', ctx, kit, () => kit.clientFor(ctx).calendar.invites(entity, id)),
    }),
  }),
};
