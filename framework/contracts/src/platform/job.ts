import { z } from 'zod';
import { MimeType } from '../framework/files.js';

/**
 * Long-running jobs, as `/api/jobs` shows them: work that runs elsewhere (or in the worker) for
 * minutes, started by a write, followed through progress updates, and finished with an output
 * and result files. A job about a record is reached through that record; a job about no record
 * by the person it was started for.
 */

/** queued (not handed over yet), running, then succeeded, failed or cancelled for good. */
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

/** The statuses a job never leaves. */
export const FINISHED_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isJobFinished = (status: JobStatus) => FINISHED_JOB_STATUSES.includes(status);

/** Why a job failed: a stable code and a plain sentence. */
export const JobError = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(500),
});
export type JobError = z.infer<typeof JobError>;

/** The record a job is about. */
export const JobAbout = z.object({ entity: z.string(), id: z.string() });
export type JobAbout = z.infer<typeof JobAbout>;

export const JobInfo = z.object({
  id: z.string(),
  /** Its kind, as `defineJob` named it: 'reports.export'. */
  kind: z.string(),
  status: JobStatus,
  /** 0 to 100, once the work reports it. */
  progress: z.number().int().min(0).max(100).nullable(),
  /** The latest word from the work ("Lighting the scene"). */
  message: z.string().nullable(),
  about: JobAbout.nullable(),
  input: z.unknown(),
  /** What it produced, once it succeeded. */
  output: z.unknown().nullable(),
  error: JobError.nullable(),
  /** Its result files (ids for `/api/files`), once it succeeded. */
  files: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** It fails as timed out if it has not finished by then. */
  deadlineAt: z.iso.datetime(),
});
export type JobInfo = z.infer<typeof JobInfo>;

/** One result file: its bytes inline (base64) or a URL to fetch them from, exactly one. */
export const JobResultFile = z
  .object({
    name: z.string().min(1).max(255),
    mime: MimeType,
    data: z.base64().optional(),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .optional(),
  })
  .refine((f) => (f.data === undefined) !== (f.url === undefined), {
    message: 'Give exactly one of data and url',
  });
export type JobResultFile = z.infer<typeof JobResultFile>;

const Message = z.string().max(500);

/**
 * What the work reports, by callback or when polled: how far it got, that it finished (with its
 * output and files), that it failed, or that it was cancelled on its side. This is also the body
 * of a callback in the framework's own format.
 */
export const JobUpdate = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('running'),
    /** 0 to 100. Lower than before: ignored. */
    progress: z.number().min(0).max(100).optional(),
    message: Message.optional(),
  }),
  z.object({
    status: z.literal('succeeded'),
    output: z.unknown().optional(),
    files: z.array(JobResultFile).max(100).optional(),
    message: Message.optional(),
  }),
  z.object({
    status: z.literal('failed'),
    error: z.object({ code: z.string().min(1).max(64).optional(), message: Message }),
  }),
  z.object({ status: z.literal('cancelled'), message: Message.optional() }),
]);
export type JobUpdate = z.infer<typeof JobUpdate>;

/** GET /api/jobs: a record's jobs (`entity` and `id`), or else the caller's own. */
export const ListJobsQuery = z.object({
  entity: z.string().min(1).max(64).optional(),
  id: z.string().min(1).max(64).optional(),
  kind: z.string().min(1).max(64).optional(),
  status: JobStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListJobsQuery = z.input<typeof ListJobsQuery>;
