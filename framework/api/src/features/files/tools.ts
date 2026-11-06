import { safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const FileId = z.object({
  id: z.uuid().describe('The file id, as a record or a message names it'),
});

/**
 * The assistant's file tools. Like every tool, they call the API as the agent, acting for the
 * person: a file is reached only through a record they can read, or as their own upload. Neither
 * returns a download link; files are put on records by the records' own create and update tools.
 */
export const filesTools: ToolContribution = {
  name: 'files',
  tools: (kit) => ({
    'get-file': createTool({
      id: 'get-file',
      description:
        "One file's details: its name, type, size, the record it is on, and an audio file's words once transcribed.",
      inputSchema: FileId,
      execute: async ({ id }, ctx) =>
        safely('get-file', ctx, kit, () => kit.clientFor(ctx).files.get(id)),
    }),
    'transcribe-file': createTool({
      id: 'transcribe-file',
      description:
        'The words spoken in an audio file (a voice note), with their language. Kept on the file once heard.',
      inputSchema: FileId,
      execute: async ({ id }, ctx) =>
        safely('transcribe-file', ctx, kit, () => kit.clientFor(ctx).files.transcribe(id)),
    }),
  }),
};
