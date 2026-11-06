import { sql } from 'drizzle-orm';
import { index, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * A write that can still be undone (its approval level's undo window): what it touched, before
 * and after, and the events held back for it. The person it was for undoes it until `until`
 * (`POST /api/undo/:id`, @hykr/core); undoing reverses each row through the write path and
 * withdraws the held events. Rows are forgotten a day after their window closes.
 */
export const undoWindows = app.table(
  'undo_windows',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The person the write was for: only they may undo it. */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The write: 'todo.update'. */
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    /** Each row it changed: [{ type, id, change, before, after }], rows as stored (JSON). */
    touched: jsonb('touched').notNull(),
    /** The events it stored, held back until `until` (app.domain_events ids). */
    eventIds: text('event_ids').array().notNull().default(sql`'{}'::text[]`),
    requestId: text('request_id'),
    until: timestamp('until', { withTimezone: true }).notNull(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('undo_windows_user_idx').on(table.tenantId, table.userId),
    index('undo_windows_until_idx').on(table.until),
  ],
);
