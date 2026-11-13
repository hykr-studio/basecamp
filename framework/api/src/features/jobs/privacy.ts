import { type Subject, subjectKey } from '@hykr/contracts';
import { files, jobs } from '@hykr/db';
import { and, eq, inArray, isNull, lt, ne, type SQL } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';
import { fileCopies } from '../files/privacy.js';
import {
  definePersonalDataPart,
  type PersonalDataPart,
  type RetentionTarget,
} from '../privacy/registry.js';
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
 * Their copies lose the same (`job.*` audit rows, events, replies), and the files' copies their
 * names (`file.*` audit rows).
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
    const gone = await tx
      .update(files)
      .set({ status: 'erased', detachedAt: now, name: 'erased', transcript: null })
      .where(and(eq(files.resourceType, JOB), inArray(files.resourceId, ids)))
      .returning({ id: files.id });
    return {
      count: rows.length,
      erased: [
        { type: JOB, ids, fields: ['input', 'output', 'message', 'error', 'principal'] },
        fileCopies(gone.map((f) => f.id)),
      ],
    };
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

/**
 * A job's result files (a business export's archive, an import's error report) copy other
 * people's records: erasing one of them leaves the copies made before (decisions V8), so they
 * are on the register as kept, and this target erases them once the job finished longer ago
 * than the period the application or the business sets (a record keeps the copy `complete` put
 * on it). Without a period they stay. An import's own file is an upload on no record: the files
 * sweeper deletes it.
 */
export const jobsFilesRetention: RetentionTarget = {
  name: 'jobs.files',
  label: {
    en: 'Files of finished jobs: exports and import error reports',
    hi: 'पूरे हो चुके कामों की फ़ाइलें: एक्सपोर्ट और इम्पोर्ट की गड़बड़ियों की रिपोर्ट',
    te: 'పూర్తయిన పనుల ఫైల్‌లు: ఎగుమతులు, దిగుమతి లోపాల నివేదికలు',
  },
  scope: 'tenant',
  action: 'delete',
  apply: async ({ tenantId, before, tx }) => {
    if (!tenantId) return { count: 0 };
    const old = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), lt(jobs.finishedAt, before)));
    const gone = await tx
      .update(files)
      .set({ status: 'erased', detachedAt: new Date(), name: 'erased', transcript: null })
      .where(
        and(
          eq(files.tenantId, tenantId),
          eq(files.resourceType, JOB),
          ne(files.status, 'erased'),
          inArray(files.resourceId, old),
        ),
      )
      .returning({ id: files.id });
    const ids = gone.map((f) => f.id);
    return { count: ids.length, erased: [fileCopies(ids)] };
  },
};

/** What the register lists for jobs' files: kept on erasure, until their period. */
export const jobsParts: PersonalDataPart[] = [
  definePersonalDataPart({
    name: 'jobs.files',
    label: jobsFilesRetention.label,
    fields: ['files'],
    erase: 'keep',
    keepReason: 'business_copy',
  }),
];
