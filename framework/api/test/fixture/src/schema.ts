// The fixture's tables, created by its own migrations (drizzle/) before the tests boot.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { boolean, date, text, timestamp } from 'drizzle-orm/pg-core';

const common = () => ({
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  customerId: customerColumn(),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const tasks = app.table('fixture_tasks', {
  ...common(),
  title: text('title').notNull(),
  done: boolean('done').notNull().default(false),
  dueOn: date('due_on'),
});

export const visits = app.table('fixture_visits', {
  ...common(),
  title: text('title').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
});
