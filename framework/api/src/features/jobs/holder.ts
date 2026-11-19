import { jobs } from '@hykr/db';
import { and, eq } from 'drizzle-orm';
import type { FileHolder } from '../files/holders.js';
import { infoOf, JOB, presentJob, RESULTS_FIELD, reachesJob } from './info.js';

/**
 * A job's result files are kept on the job: whoever reaches the job, and still sees the file
 * among its results once the job is projected for them, reaches the file.
 */
export const jobFiles: FileHolder = {
  type: JOB,
  async reaches({ p, resourceId, field, fileId, db }) {
    if (field !== RESULTS_FIELD || !p.tenantId) return false;
    const [row] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, resourceId), eq(jobs.tenantId, p.tenantId)));
    if (!row || !(await reachesJob(db, p, row))) return false;
    const files = presentJob(infoOf(row), p).files;
    return Array.isArray(files) && files.includes(fileId);
  },
};
