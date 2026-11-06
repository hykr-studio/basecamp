import { type Subject, subjectKey } from '@hykr/contracts';
import { files, jobs } from '@hykr/db';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';
import { JOB } from './info.js';

/** The jobs started for a subject, in one business or in all. */
const startedFor = (subject: Subject, tenantId?: string): SQL =>
  and(
    eq(jobs.startedFor, subjectKey(subject)),
    tenantId ? eq(jobs.tenantId, tenantId) : undefined,
  ) as SQL;

/**
 * "Delete my data": the jobs about no record that were started for the subject lose their
 * input, output, message and error, their result files are erased (the files sweeper deletes the
 * objects), and unfinished ones are cancelled. Jobs about a record are the business's: they stay.
 */
export const jobsErasure: ErasureContributor = {
  name: 'jobs',
  async erase({ subject, tenantId, tx }) {
    const personal = and(startedFor(subject, tenantId), isNull(jobs.aboutType)) as SQL;
    const rows = await tx.select({ id: jobs.id, status: jobs.status }).from(jobs).where(personal);
    if (!rows.length) return { count: 0 };
    const ids = rows.map((r) => r.id);
    const now = new Date();
    await tx
      .update(jobs)
      .set({ input: {}, output: null, message: null, error: null, principal: null })
      .where(inArray(jobs.id, ids));
    await tx
      .update(jobs)
      .set({
        status: 'cancelled',
        error: { code: 'erased', message: 'Its data was erased' },
        finishedAt: now,
        leaseUntil: null,
        nextPollAt: null,
      })
      .where(and(inArray(jobs.id, ids), inArray(jobs.status, ['queued', 'running'])));
    await tx
      .update(files)
      .set({ status: 'erased', detachedAt: now, name: 'erased' })
      .where(and(eq(files.resourceType, JOB), inArray(files.resourceId, ids)));
    return { count: rows.length };
  },
};

/** The jobs started for the subject, for their data export. */
export const jobsExport: ExportContributor = {
  name: 'jobs',
  async export({ subject, tenantId, db }) {
    const rows = await db.select().from(jobs).where(startedFor(subject, tenantId));
    return {
      jobs: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        kind: r.kind,
        status: r.status,
        about: r.aboutType ? { entity: r.aboutType, id: r.aboutId } : null,
        input: r.input,
        output: r.output,
        error: r.error,
        files: r.resultFiles,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
    };
  },
};
