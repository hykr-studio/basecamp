import { JobStatus } from '@hykr/contracts';
import { safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * The assistant's job tools. Like every tool, they call the API as the agent, acting for the
 * person: a job is reached through the record it is about, or as the person's own. Starting a
 * job is the application's own command; cancelling is for people.
 */
export const jobsTools: ToolContribution = {
  name: 'jobs',
  tools: (kit) => ({
    'get-job': createTool({
      id: 'get-job',
      description:
        "One long-running job: its kind, status, progress (0-100), latest message, error, and its result files' ids.",
      inputSchema: z.object({ id: z.uuid().describe('The job id') }),
      execute: async ({ id }, ctx) =>
        safely('get-job', ctx, kit, () => kit.clientFor(ctx).jobs.get(id)),
    }),
    'list-jobs': createTool({
      id: 'list-jobs',
      description:
        "Long-running jobs, newest first: a record's jobs (give entity and id), or else the person's own.",
      inputSchema: z.object({
        entity: z.string().optional().describe("The record's entity name, as in its tools"),
        id: z.string().optional().describe("The record's id"),
        status: JobStatus.optional(),
      }),
      execute: async (q, ctx) =>
        safely('list-jobs', ctx, kit, async () => ({
          items: await kit.clientFor(ctx).jobs.list(q),
        })),
    }),
  }),
};
