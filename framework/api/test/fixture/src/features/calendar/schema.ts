// The calendar feature's fixture table (its own migration set, migrations/ next to this file):
// appointments with a time, a place, notes and a second person. Generate with
// `FIXTURE_FEATURE=calendar pnpm fixture:generate --name calendar`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { index, text, timestamp } from 'drizzle-orm/pg-core';

export const appointments = app.table(
  'fixture_appointments',
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
    place: text('place'),
    notes: text('notes'),
    /** A second person whose calendar it belongs on. */
    assigneeId: text('assignee_id').references(() => user.id),
    status: text('status').notNull().default('booked'),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('fixture_appointments_owner_idx').on(t.tenantId, t.ownerId, t.startsAt)],
);
