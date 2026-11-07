import { index, integer, jsonb, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './base.js';
import { jobs } from './jobs.js';
import { tenantColumn } from './tenancy.js';

/**
 * Which record each row of an import became (the imports feature): per business, entity and
 * source (the other system), its id there → our record's id. A run of the same import finds
 * its records here and updates them instead of making them again. Written in the same
 * savepoint as the record's own write; ids only.
 */
export const importKeys = app.table(
  'import_keys',
  {
    tenantId: tenantColumn(),
    /** The entity's name: 'todo'. */
    entity: text('entity').notNull(),
    /** The other system: 'legacy-crm'. */
    source: text('source').notNull(),
    /** The row's id there. */
    externalId: text('external_id').notNull(),
    /** Our record's id. */
    recordId: text('record_id').notNull(),
    /** The import that last wrote it. */
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.entity, table.source, table.externalId] }),
    index('import_keys_record_idx').on(table.tenantId, table.entity, table.recordId),
  ],
);

/**
 * One committed batch of a running import, with what it did: a retried run skips these batches
 * and reuses their counts and problem rows. Deleted when the import finishes.
 */
export const importBatches = app.table(
  'import_batches',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** From 0, in file order. */
    batch: integer('batch').notNull(),
    tenantId: tenantColumn(),
    /** { created, updated, unchanged, skipped }. */
    counts: jsonb('counts').notNull(),
    /** The batch's rows that were not written, as the error report lists them. */
    problems: jsonb('problems').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.batch] })],
);
