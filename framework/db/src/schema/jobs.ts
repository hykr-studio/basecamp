import { sql } from 'drizzle-orm';
import { index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * Long-running jobs (the jobs feature): work handed to an outside service, or run in the
 * worker, that reports progress and finishes with an output and result files. A row is
 * inserted by `startJob` in a write's transaction, so it exists exactly when that write
 * committed; from then on only the jobs feature changes it, auditing each step.
 */
export const jobs = app.table(
  'jobs',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The kind, as `defineJob` named it: 'reports.export'. */
    kind: text('kind').notNull(),
    /** queued, running, succeeded, failed or cancelled (JobStatus in @hykr/contracts). */
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    /** 0 to 100, once reported. It only goes up. */
    progress: integer('progress'),
    message: text('message'),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    /** { code, message } when it failed or was cancelled. */
    error: jsonb('error'),
    /** Its result files (app.files ids), kept on the job (resource_type 'job'). */
    resultFiles: text('result_files').array().notNull().default(sql`'{}'::text[]`),
    /** The outside service's id for it. Never shown. */
    externalId: text('external_id'),
    /** The record it is about: reaching that record is reaching the job. */
    aboutType: text('about_type'),
    aboutId: text('about_id'),
    /** Whom it was started for: 'user:<id>' or 'contact:<id>' (none for the server's own). */
    startedFor: text('started_for'),
    /** Who started it, as audit names them. */
    startedByKind: text('started_by_kind').notNull(),
    startedById: text('started_by_id').notNull(),
    requestId: text('request_id'),
    /** Submissions tried so far. */
    attempts: integer('attempts').notNull().default(0),
    /** A submission or a poll in progress holds the job until then. */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** When the worker asks the service next (kinds that poll). */
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    /** Not finished by then: it fails as timed out. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    /** The kind's `complete` hook: pending, done or failed (null: the kind has none). */
    completion: text('completion', { enum: ['pending', 'done', 'failed'] }),
    completionAttempts: integer('completion_attempts').notNull().default(0),
    completionError: text('completion_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('jobs_about_idx').on(table.tenantId, table.aboutType, table.aboutId, table.createdAt),
    index('jobs_started_for_idx').on(table.tenantId, table.startedFor, table.createdAt),
    index('jobs_external_idx').on(table.kind, table.externalId),
    index('jobs_open_idx')
      .on(table.status, table.deadlineAt)
      .where(sql`${table.status} in ('queued', 'running')`),
    index('jobs_poll_idx')
      .on(table.nextPollAt)
      .where(sql`${table.status} = 'running' and ${table.nextPollAt} is not null`),
  ],
);

/**
 * What a job's work reported, each update once: a callback (verified, then stored under its
 * dedupe key, so a repeat is a no-op), a poll's answer, or what a submission returned. The
 * jobs feature applies each one, in the worker, and notes the outcome.
 */
export const jobUpdates = app.table(
  'job_updates',
  {
    id: id(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    tenantId: tenantColumn(),
    source: text('source', { enum: ['callback', 'poll', 'submit'] }).notNull(),
    /** Unique per job: the raw body's hash, or a provider's delivery id. */
    dedupe: text('dedupe').notNull(),
    status: text('status').notNull(),
    /** The JobUpdate. Inline file data is dropped once applied. */
    body: jsonb('body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** applied, ignored (late, lower, finished) or failed (and why). */
    outcome: text('outcome'),
  },
  (table) => [
    uniqueIndex('job_updates_dedupe_idx').on(table.jobId, table.dedupe),
    index('job_updates_pending_idx').on(table.receivedAt).where(sql`${table.appliedAt} is null`),
  ],
);
