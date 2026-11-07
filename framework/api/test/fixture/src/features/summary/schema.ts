// The summary feature's tables (its own migration set, migrations/ next to this file): entries
// with a state, money, a number, dates and a margin staff never see. Generate with
// `FIXTURE_FEATURE=summary pnpm fixture:generate --name summary`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, currencyColumn, customerColumn, id, minorUnits, tenantColumn, user } from '@hykr/db';
import { boolean, date, index, integer, text, timestamp } from 'drizzle-orm/pg-core';

export const entries = app.table(
  'fixture_entries',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    state: text('state', { enum: ['draft', 'done', 'void'] })
      .notNull()
      .default('draft'),
    flagged: boolean('flagged').notNull().default(false),
    currency: currencyColumn(),
    amount: minorUnits('amount').notNull().default(0),
    units: integer('units').notNull().default(0),
    /** Hidden from staff by the fixture's read projector. */
    margin: integer('margin'),
    bookedAt: timestamp('booked_at', { withTimezone: true }),
    dueOn: date('due_on'),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('fixture_entries_tenant_state_idx').on(t.tenantId, t.state)],
);
