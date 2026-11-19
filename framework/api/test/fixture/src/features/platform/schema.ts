// The platform feature's fixture tables (B19): issues (what a routed request becomes in the
// business that takes it, with a note only some capabilities read) and parts (records the
// platform shares with every business, published by its operators). Generate with
// `FIXTURE_FEATURE=platform pnpm fixture:generate --name platform`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, sharedFromColumn, tenantColumn, user } from '@hykr/db';
import { text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const common = () => ({
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const issues = app.table('fixture_issues', {
  ...common(),
  customerId: customerColumn(),
  title: text('title').notNull(),
  /** Only some capabilities read it. */
  note: text('note'),
});

export const parts = app.table(
  'fixture_parts',
  {
    ...common(),
    sharedId: sharedFromColumn(),
    title: text('title').notNull(),
  },
  (table) => [uniqueIndex('fixture_parts_shared_idx').on(table.tenantId, table.sharedId)],
);
