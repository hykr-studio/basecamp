// The line-items feature's tables (its own migration set, migrations/ next to this file):
// baskets with money, numbers and a tree of items. Generate with
// `FIXTURE_FEATURE=line-items pnpm fixture:generate --name line-items`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, currencyColumn, customerColumn, id, minorUnits, tenantColumn, user } from '@hykr/db';
import {
  type AnyPgColumn,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const provenance = () => ({
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const baskets = app.table(
  'fixture_baskets',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    /** From the series, on a save: null for a basket made by plain CRUD. */
    number: text('number'),
    title: text('title').notNull(),
    status: text('status', { enum: ['open', 'void'] })
      .notNull()
      .default('open'),
    currency: currencyColumn(),
    total: minorUnits('total').notNull().default(0),
    taxTotal: minorUnits('tax_total').notNull().default(0),
    ...provenance(),
  },
  (t) => [
    // What a child's (tenant_id, basket_id) points at: a basket of its own business.
    unique('fixture_baskets_tenant_id_uq').on(t.tenantId, t.id),
    unique('fixture_baskets_number_uq').on(t.tenantId, t.number),
  ],
);

export const basketItems = app.table(
  'fixture_baskets_items',
  {
    id: id(),
    tenantId: tenantColumn(),
    basketId: text('basket_id').notNull(),
    /** The node above it in the basket's tree; null at the top. */
    parentItemId: text('parent_item_id'),
    position: integer('position').notNull().default(0),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    quantity: integer('quantity').notNull().default(1),
    currency: currencyColumn(),
    price: minorUnits('price'),
    /** Hidden from staff by the fixture's read projector. */
    cost: minorUnits('cost'),
    amount: minorUnits('amount').notNull().default(0),
    ...provenance(),
  },
  (t) => [
    unique('fixture_baskets_items_basket_id_uq').on(t.basketId, t.id),
    foreignKey({
      name: 'fixture_baskets_items_basket_fk',
      columns: [t.tenantId, t.basketId],
      foreignColumns: [baskets.tenantId, baskets.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fixture_baskets_items_parent_fk',
      columns: [t.basketId, t.parentItemId],
      foreignColumns: [t.basketId, t.id] as [AnyPgColumn, AnyPgColumn],
    }).onDelete('cascade'),
    index('fixture_baskets_items_basket_idx').on(t.basketId, t.position),
  ],
);
