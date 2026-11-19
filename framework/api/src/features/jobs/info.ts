// A job as it leaves the server, its events, and who reaches it. Nothing here loads Nest.
import type { JobError, JobInfo, JobStatus, Principal } from '@hykr/contracts';
import { type Conn, entityDef, type NamedEvent, projectRead } from '@hykr/core';
import type { jobs } from '@hykr/db';
import { subjectKeyOf } from '@hykr/policy';
import type { JobRecord } from './define.js';

export type JobRow = typeof jobs.$inferSelect;

/** The resource type of jobs: their audit rows, events, read projections and files. */
export const JOB = 'job';

/** The field a job's result files are kept on. */
export const RESULTS_FIELD = 'results';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A job as the API shows it, before projection: never its external id, lease or attempts. */
export function infoOf(row: JobRow): JobInfo {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as JobStatus,
    progress: row.progress,
    message: row.message,
    about: row.aboutType && row.aboutId ? { entity: row.aboutType, id: row.aboutId } : null,
    input: row.input,
    output: row.output ?? null,
    error: (row.error as JobError | null) ?? null,
    files: row.resultFiles,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: iso(row.submittedAt),
    finishedAt: iso(row.finishedAt),
    deadlineAt: row.deadlineAt.toISOString(),
  };
}

/** A job as p may see it: through the read projectors, resource type 'job'. */
export function presentJob(info: JobInfo, p: Principal): JobInfo {
  return projectRead(JOB, info as unknown as Record<string, unknown>, p) as unknown as JobInfo;
}

/** A job as its kind's functions see it. */
export function recordOf<I>(row: JobRow): JobRecord<I> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    input: row.input as I,
    externalId: row.externalId,
    about: row.aboutType && row.aboutId ? { entity: row.aboutType, id: row.aboutId } : null,
    attempt: row.attempts,
    deadlineAt: row.deadlineAt,
  };
}

/** job.queued, job.running, job.progress, job.succeeded, job.failed, job.cancelled. */
export type JobEventName =
  | 'job.queued'
  | 'job.running'
  | 'job.progress'
  | 'job.succeeded'
  | 'job.failed'
  | 'job.cancelled';

/** A job's change, stored in the event outbox with the job as its row (`JobInfo`). */
export class JobEvent implements NamedEvent {
  readonly resourceType = JOB;
  constructor(
    readonly eventName: JobEventName,
    readonly row: JobInfo,
  ) {}
  get resourceId() {
    return this.row.id;
  }
}

/**
 * Does p reach this job? Same business, always. The server's own work of that business does.
 * A job about a record: p reaches that record (its scoped repo), and an agent may read that
 * entity. A job about no record: the person or contact it was started for.
 */
export async function reachesJob(conn: Conn, p: Principal, row: JobRow): Promise<boolean> {
  if (!p.tenantId || row.tenantId !== p.tenantId) return false;
  if (p.actor.kind === 'system') return true;
  if (row.aboutType && row.aboutId) {
    const def = entityDef(row.aboutType);
    if (!def) return false;
    if (p.actor.kind === 'agent' && def.spec.expose.get !== 'all') return false;
    return !!(await def.repo.find(conn, p, row.aboutId));
  }
  const key = subjectKeyOf(p);
  return !!key && row.startedFor === key;
}
