import { RenderDocumentSpec, SendDocumentSpec } from '@hykr/contracts';
import { commandTools, safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * The assistant's document tools. Like every tool, they call the API as the agent, acting for
 * the person: render-document and send-document are the commands (a send to someone else waits
 * for the person's approval); get-document and list-documents read, never with a download link.
 */
export const documentsTools: ToolContribution = {
  name: 'documents',
  tools: (kit) => ({
    ...commandTools([RenderDocumentSpec, SendDocumentSpec], kit),
    'get-document': createTool({
      id: 'get-document',
      description:
        "One document's state: pending (being made), ready or failed, its file name, size and pages, and its sends (to whom, by which channel, sent or not).",
      inputSchema: z.object({ id: z.uuid().describe('The document id, from render-document') }),
      execute: async ({ id }, ctx) =>
        safely('get-document', ctx, kit, () => kit.clientFor(ctx).documents.get(id)),
    }),
    'list-documents': createTool({
      id: 'list-documents',
      description:
        "A record's documents, newest first: each version's kind, state and file name. With no record, the kinds of document there are.",
      inputSchema: z.object({
        entity: z.string().min(1).describe("The record's kind (an entity name)"),
        id: z.string().min(1).optional().describe("The record's id; leave out for the kinds"),
      }),
      execute: async ({ entity, id }, ctx) =>
        safely(
          'list-documents',
          ctx,
          kit,
          async (): Promise<unknown> =>
            id
              ? kit.clientFor(ctx).documents.list(entity, id)
              : kit.clientFor(ctx).documents.kinds(entity),
        ),
    }),
  }),
};
