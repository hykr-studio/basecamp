/** The to-dos module's tables. */
import {
  app,
  customerColumn,
  customFieldsColumn,
  id,
  tenantColumn,
  user,
  versionColumn,
} from '@hykr/db';
import { boolean, date, index, integer, text, timestamp } from 'drizzle-orm/pg-core';

export const todos = app.table(
  'todos',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    done: boolean('done').default(false).notNull(),
    dueOn: date('due_on'),
    /** What it costs, in minor units of the business's currency (hidden by field policy). */
    cost: integer('cost'),
    // The meeting it belongs to, in the same business: the spec declares the reference, and
    // sql/post/meeting-references.sql keys (tenant_id, meeting_id) to the meeting's
    // (tenant_id, id) with ON DELETE SET NULL (meeting_id), which drizzle cannot say.
    meetingId: text('meeting_id'),
    /** The business's own fields: keys and types from its custom field definitions. */
    custom: customFieldsColumn(),
    /** Counts changes: a change made on a phone offline is sent with the version it saw. */
    version: versionColumn(),
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
    index('todos_owner_id_idx').on(table.ownerId),
    index('todos_meeting_idx').on(table.meetingId),
    index('todos_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
);
