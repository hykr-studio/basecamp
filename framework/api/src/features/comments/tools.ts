import { safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const Record = {
  entity: z.string().describe("The record's type: an entity name, as its get tool names it"),
  id: z.string().describe("The record's id"),
};

/**
 * The assistant's reading of comments. Like every tool, they call the API as the agent, acting
 * for the person: a record they cannot read has no comments for it. Adding a comment is the
 * `add-comment` tool of the comment.add command.
 */
export const commentsTools: ToolContribution = {
  name: 'comments',
  tools: (kit) => ({
    'list-comments': createTool({
      id: 'list-comments',
      description:
        "A record's comments, newest first: who wrote what, and whom it mentions. Pass nextCursor back as cursor for older ones.",
      inputSchema: z.object({
        ...Record,
        cursor: z.string().optional().describe('From a previous call, for older comments'),
      }),
      execute: async ({ entity, id, cursor }, ctx) =>
        safely('list-comments', ctx, kit, () =>
          kit.clientFor(ctx).comments.list({ entity, id, cursor, limit: 20 }),
        ),
    }),
    'list-mentionable': createTool({
      id: 'list-mentionable',
      description:
        'People a comment on this record may mention, by the start of their name. Mention one in add-comment as @[Name](user:<id>).',
      inputSchema: z.object({
        ...Record,
        q: z.string().optional().describe('The start of their name'),
      }),
      execute: async ({ entity, id, q }, ctx) =>
        safely('list-mentionable', ctx, kit, () =>
          kit.clientFor(ctx).comments.mentionable({ entity, id, q }),
        ),
    }),
  }),
};
