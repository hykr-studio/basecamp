import { type PgSchema, text } from 'drizzle-orm/pg-core';
import { app } from './schema/base.js';

/**
 * Another module's table, by name only, for a foreign key from a module that must not import it:
 * `meetingId: text('meeting_id').references(() => tableRef('meetings').id)` in the notes module,
 * while `meetings` depends on `notes`. Its module owns and migrates the real table; this one is
 * never exported from a schema file, so drizzle-kit sees only the reference. Not for queries.
 */
export const tableRef = (name: string, schema: PgSchema = app) =>
  schema.table(name, { id: text('id').notNull() });
