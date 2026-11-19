// The parties feature's fixture tables (B7): cases that parties participate in, with a budget only
// some capabilities read, and their notes, which follow their case's participations. Generate with
// `FIXTURE_FEATURE=parties pnpm fixture:generate --name parties`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { index, integer, text, timestamp } from 'drizzle-orm/pg-core';

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

export const cases = app.table('fixture_cases', {
  ...common(),
  title: text('title').notNull(),
  /** Minor units of the business's currency: only some capabilities read it. */
  budget: integer('budget'),
});

export const caseNotes = app.table(
  'fixture_cases_notes',
  {
    ...common(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
  },
  (table) => [index('fixture_cases_notes_case_idx').on(table.caseId)],
);
