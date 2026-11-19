import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * Comments on records (the comments feature in @hykr/api). A comment is on one record, named by
 * its entity and id (`resource_type`, `resource_id`); there is no foreign key to it, and whoever
 * may read that record reads its comments. Rows are written by the comment commands, through
 * the write path.
 */
export const comments = app.table(
  'comments',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The record's entity ('order') and id. */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** The person who wrote it (or whose assistant did). */
    authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    /** The text, with mention tokens: @[Name](user:<id>). */
    body: text('body').notNull(),
    /** Who it names: [{ kind, id, label }]. */
    mentions: jsonb('mentions').notNull().default(sql`'[]'::jsonb`),
    /** Only for people who may read team-only comments. */
    internal: boolean('internal').notNull().default(false),
    /** Where on the record it is pinned, as the entity's comments trait allows. */
    anchor: jsonb('anchor'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('comments_record_idx').on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
    index('comments_author_idx').on(table.authorId),
  ],
);
