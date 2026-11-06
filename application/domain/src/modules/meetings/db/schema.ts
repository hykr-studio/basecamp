/**
 * The meetings module's tables. Each table needs an id, a tenant and an owner column
 * (customerColumn() too, for records customers have), and created_by/created_at/updated_at to get
 * the framework's scoping, provenance and list grammar. Its tables are named after the module.
 */

import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { sql } from 'drizzle-orm';
import { index, text, timestamp } from 'drizzle-orm/pg-core';

export const meetings = app.table(
  'meetings',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    attendees: text('attendees').array().notNull().default(sql`'{}'::text[]`),
    status: text('status', { enum: ['scheduled', 'held', 'closed'] })
      .notNull()
      .default('scheduled'),
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
    index('meetings_owner_starts_idx').on(table.ownerId, table.startsAt),
    index('meetings_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
);
