/** The orders module's tables, named after the module. */
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { index, text, timestamp } from 'drizzle-orm/pg-core';

export const orders = app.table(
  'orders',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
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
  (table) => [index('orders_tenant_customer_idx').on(table.tenantId, table.customerId)],
);
