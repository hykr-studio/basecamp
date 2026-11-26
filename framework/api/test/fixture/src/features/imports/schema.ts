// The imports feature's fixture tables: shelves, and items that may name their shelf. Its own
// migration set (migrations/, `FIXTURE_FEATURE=imports pnpm fixture:generate --name imports`).
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { boolean, integer, text, timestamp } from 'drizzle-orm/pg-core';

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

export const shelves = app.table('fixture_shelves', {
  ...common(),
  title: text('title').notNull(),
});

export const items = app.table('fixture_shelves_items', {
  ...common(),
  title: text('title').notNull(),
  shelfId: text('shelf_id').references(() => shelves.id, { onDelete: 'set null' }),
  qty: integer('qty').notNull().default(0),
  /** Read and written only with `fixture.items.cost`. */
  cost: integer('cost'),
  /** Set by an update only. */
  done: boolean('done').notNull().default(false),
  tags: text('tags').array(),
});

/** Bins: never imported (`traits.imports: false`). */
export const bins = app.table('fixture_shelves_bins', {
  ...common(),
  title: text('title').notNull(),
});
