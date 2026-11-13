/** The notes module's tables. */
import { app, customerColumn, fileColumns, id, tenantColumn, user } from '@hykr/db';
import { index, text, timestamp } from 'drizzle-orm/pg-core';

export const notes = app.table(
  'notes',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    // The meeting it belongs to, in the same business: the spec declares the reference, and
    // sql/post/meeting-references.sql keys it (see the to-dos' schema).
    meetingId: text('meeting_id'),
    /** Photos: file ids (app.files), in order. */
    photos: fileColumns('photos'),
    /** Who made the row: the person, or the assistant acting for them. Set by the framework. */
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('notes_owner_created_idx').on(table.ownerId, table.createdAt),
    index('notes_meeting_idx').on(table.meetingId),
    index('notes_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
);
