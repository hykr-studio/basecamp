/** The briefs module's tables, named after the module. */
import {
  app,
  currencyColumn,
  customerColumn,
  customFieldsColumn,
  id,
  minorUnits,
  tenantColumn,
  user,
} from '@hykr/db';
import { date, index, text, timestamp } from 'drizzle-orm/pg-core';

export const briefs = app.table(
  'briefs',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    name: text('name').notNull(),
    phone: text('phone'),
    summary: text('summary').notNull(),
    /** In minor units of `currency`. */
    budget: minorUnits('budget'),
    currency: currencyColumn(),
    neededBy: date('needed_by'),
    notes: text('notes').notNull().default(''),
    status: text('status', { enum: ['new', 'reviewed'] })
      .notNull()
      .default('new'),
    source: text('source', { enum: ['team', 'form'] })
      .notNull()
      .default('team'),
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
    index('briefs_tenant_customer_idx').on(table.tenantId, table.customerId),
    index('briefs_tenant_status_idx').on(table.tenantId, table.status),
  ],
);
