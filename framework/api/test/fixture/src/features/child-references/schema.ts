// The child-references feature's tables (its own migration set, migrations/ next to this file):
// price items, sheets with revisions, and a tree of sheet lines that name price items (R1).
// Generate with `FIXTURE_FEATURE=child-references pnpm fixture:generate --name child-references`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import {
  app,
  customerColumn,
  id,
  revisionColumns,
  tenantColumn,
  user,
  versionColumn,
} from '@hykr/db';
import {
  type AnyPgColumn,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

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

export const priceItems = app.table(
  'fixture_sheets_items',
  {
    ...common(),
    name: text('name').notNull(),
    /** Read only with the fixture's cost capability (field policy). */
    cost: integer('cost'),
  },
  // What a line's (tenant_id, item_id) points at: an item of its own business.
  (t) => [unique('fixture_sheets_items_tenant_id_uq').on(t.tenantId, t.id)],
);

export const sheets = app.table(
  'fixture_sheets',
  {
    ...common(),
    title: text('title').notNull(),
    version: versionColumn(),
    ...revisionColumns(),
  },
  (t) => [unique('fixture_sheets_tenant_id_uq').on(t.tenantId, t.id)],
);

export const sheetLines = app.table(
  'fixture_sheets_lines',
  {
    ...common(),
    sheetId: text('sheet_id').notNull(),
    parentLineId: text('parent_line_id'),
    position: integer('position').notNull().default(0),
    title: text('title').notNull(),
    /** Declared, keyed NO ACTION in its own business: an item still named cannot be deleted. */
    itemId: text('item_id'),
    /** Declared, keyed ON DELETE SET NULL (alt_item_id) by sql/post (drizzle cannot say it). */
    altItemId: text('alt_item_id'),
  },
  (t) => [
    unique('fixture_sheets_lines_sheet_id_uq').on(t.sheetId, t.id),
    foreignKey({
      name: 'fixture_sheets_lines_sheet_fk',
      columns: [t.tenantId, t.sheetId],
      foreignColumns: [sheets.tenantId, sheets.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fixture_sheets_lines_parent_fk',
      columns: [t.sheetId, t.parentLineId],
      foreignColumns: [t.sheetId, t.id] as [AnyPgColumn, AnyPgColumn],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fixture_sheets_lines_item_fk',
      columns: [t.tenantId, t.itemId],
      foreignColumns: [priceItems.tenantId, priceItems.id],
    }),
    index('fixture_sheets_lines_sheet_idx').on(t.sheetId, t.position),
  ],
);
