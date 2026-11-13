// Jobs on the live stream (B15): a job's events reach the people who reach the job.
// The live registry's collector first: contributing `liveResources` needs it installed.
import '../live/resources.js';
import type { LiveResource } from '../live/resources.js';
import { JOB } from './info.js';
import { JobRunner } from './runner.service.js';

/** Who hears of a job's change: whoever reaches it now (the same check as GET /api/jobs/:id). */
export const jobLive: LiveResource = {
  type: JOB,
  visible: async (p, id, ctx) => {
    await ctx.get(JobRunner).reachable(p, id);
    return true;
  },
};
