import { RecallAbout } from '@hykr/contracts';
import { safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * recall-memory: semantic recall through the API (`GET /api/memory/recall`), as the person the
 * assistant acts for. The turn already brings the closest memories as context; the tool is for an
 * explicit question, or memory of one record.
 */
export const MemoryTools: ToolContribution = {
  name: 'memory',
  tools: (kit) => ({
    'recall-memory': createTool({
      id: 'recall-memory',
      description:
        'Find what is remembered about something, by meaning: the business\'s memories, records that are memory (with the record they are about), and what the person said before. Pass the question as `query`. To recall the memory of one record, pass `about` as "<type>:<id>" (an id from a list or get tool). Use it when the person asks what you remember or know about something.',
      inputSchema: z.object({
        query: z.string().min(1).max(1000).describe('What to recall, in the person’s words'),
        about: RecallAbout.optional().describe('Only memory of this record: "<type>:<id>"'),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, about, limit }, ctx) =>
        safely('recall-memory', ctx, kit, () =>
          kit.clientFor(ctx).memory.recall({
            q: query,
            ...(about ? { about } : {}),
            ...(limit ? { limit } : {}),
          }),
        ),
    }),
  }),
};
