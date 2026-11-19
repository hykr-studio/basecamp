import { sql } from 'drizzle-orm';
import { index, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * Requests about personal data (the `privacy` feature in @hykr/api): a person asked a business
 * for a copy of what it holds about them, or to be forgotten. A row is written by the request's
 * write and changed only by the feature's own writes, each audited. It names its person by id
 * only, with no foreign key, so it outlives their erasure as the business's evidence that it
 * answered.
 */
export const privacyRequests = app.table(
  'privacy_requests',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** export or erase (PrivacyRequestKind in @hykr/contracts). */
    kind: text('kind', { enum: ['export', 'erase'] }).notNull(),
    /** received, in_progress, completed, refused or failed. */
    status: text('status', {
      enum: ['received', 'in_progress', 'completed', 'refused', 'failed'],
    })
      .notNull()
      .default('received'),
    /** Whom it is about: a person ('user') or a WhatsApp contact ('contact'), by id. */
    subjectKind: text('subject_kind', { enum: ['user', 'contact'] }).notNull(),
    subjectId: text('subject_id').notNull(),
    /** How it reached the business: app, whatsapp, email, phone, post, in_person, other. */
    intake: text('intake').notNull(),
    /** Who filed it, as audit names them. */
    requestedByKind: text('requested_by_kind').notNull(),
    requestedById: text('requested_by_id').notNull(),
    note: text('note'),
    /** Why it was refused or failed. */
    reason: text('reason'),
    /** What was done, by part (counts, never the data). */
    outcome: jsonb('outcome'),
    /** A completed export's archive (app.files ids, kept on the request). */
    files: text('files').array().notNull().default(sql`'{}'::text[]`),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    overdueAt: timestamp('overdue_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** The queue prefix (BULL_PREFIX) of the process that took it: only its sweeper marks it. */
    queues: text('queues').notNull().default('bull'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('privacy_requests_tenant_idx').on(table.tenantId, table.status, table.receivedAt),
    index('privacy_requests_subject_idx').on(table.tenantId, table.subjectKind, table.subjectId),
    index('privacy_requests_due_idx')
      .on(table.queues, table.dueAt)
      .where(sql`${table.status} in ('received', 'in_progress') and ${table.overdueAt} is null`),
  ],
);
