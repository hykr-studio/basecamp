/** The to-dos module's tables. */
import {
  app,
  customerColumn,
  customFieldsColumn,
  id,
  tableRef,
  tenantColumn,
  user,
} from '@hykr/db';
import { boolean, date, index, text, timestamp } from 'drizzle-orm/pg-core';

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
    // The meeting it belongs to: meetings builds on notes, so the table is named, not imported.
    meetingId: text('meeting_id').references(() => tableRef('meetings').id, {
      onDelete: 'set null',
    }),
    /** The business's own fields: keys and types from its custom field definitions. */
    custom: customFieldsColumn(),
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
