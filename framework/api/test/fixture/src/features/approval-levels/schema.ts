// The approval-levels fixture's one table: payments with an amount in minor units and its
// currency. Its own migration set (migrations/, next to this file), generated with
// `FIXTURE_FEATURE=approval-levels pnpm --filter @hykr/api fixture:generate --name approval-levels`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { integer, text, timestamp } from 'drizzle-orm/pg-core';

export const levelPayments = app.table('fixture_levels_payments', {
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  customerId: customerColumn(),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  title: text('title').notNull(),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),
  /** Hidden from staff (a read projector): it must stay hidden on approval cards. */
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
