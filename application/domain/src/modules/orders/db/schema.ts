/** The orders module's tables, named after the module. */
import type { TaxLine } from '@hykr/contracts';
import {
  app,
  currencyColumn,
  customerColumn,
  fileColumn,
  id,
  minorUnits,
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
  jsonb,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const provenance = () => ({
  /** Who made the row: the person, or the assistant acting for them. Set by the framework. */
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const orders = app.table(
  'orders',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    /**
     * From the orders series: gapless per business, never reused (orders are cancelled). A
     * revision is its first revision's number with "-v<n>".
     */
    number: text('number').notNull(),
    title: text('title').notNull(),
    /** Its state (contracts ORDER_STATES): only its transitions move it. */
    status: text('status', {
      enum: [
        'draft',
        'submitted',
        'approved',
        'accepted',
        'fulfilled',
        'cancelled',
        'superseded',
        'expired',
      ],
    })
      .notNull()
      .default('draft'),
    cancelReason: text('cancel_reason'),
    version: versionColumn(),
    ...revisionColumns(),
    currency: currencyColumn(),
    subtotal: minorUnits('subtotal').notNull().default(0),
    taxTotal: minorUnits('tax_total').notNull().default(0),
    total: minorUnits('total').notNull().default(0),
    taxLines: jsonb('tax_lines').$type<TaxLine[]>().notNull().default([]),
    lineCount: integer('line_count').notNull().default(0),
    /** A picture shown on its PDF (a drawing, a product photo): a file the order holds. */
    photo: fileColumn('photo'),
    ...provenance(),
  },
  (table) => [
    index('orders_tenant_customer_idx').on(table.tenantId, table.customerId),
    unique('orders_tenant_number_uq').on(table.tenantId, table.number),
    // What an item's (tenant_id, order_id) points at: an order of its own business.
    unique('orders_tenant_id_uq').on(table.tenantId, table.id),
  ],
);

/** An order's groups and lines: a tree under the order (parent_item_id), in position order. */
export const orderItems = app.table(
  'orders_items',
  {
    id: id(),
    tenantId: tenantColumn(),
    orderId: text('order_id').notNull(),
    parentItemId: text('parent_item_id'),
    position: integer('position').notNull().default(0),
    /** The order's owner and customer, mirrored: whoever reaches the order reaches its items. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    kind: text('kind', { enum: ['group', 'line'] }).notNull(),
    title: text('title').notNull(),
    /**
     * The product it is (declared on the spec, `traits.references`): keyed to a product of the
     * same business by sql/post/order-products.sql, which nulls it when the product is deleted.
     */
    productId: text('product_id'),
    quantity: integer('quantity'),
    currency: currencyColumn(),
    unitPrice: minorUnits('unit_price'),
    taxRateBp: integer('tax_rate_bp'),
    amount: minorUnits('amount').notNull().default(0),
    cost: minorUnits('cost'),
    ...provenance(),
  },
  (table) => [
    unique('orders_items_order_id_uq').on(table.orderId, table.id),
    foreignKey({
      name: 'orders_items_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'orders_items_parent_fk',
      columns: [table.orderId, table.parentItemId],
      foreignColumns: [table.orderId, table.id] as [AnyPgColumn, AnyPgColumn],
    }).onDelete('cascade'),
    index('orders_items_order_idx').on(table.orderId, table.position),
  ],
);

/** The business's products: what an order's line may name. */
export const products = app.table(
  'orders_products',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    name: text('name').notNull(),
    sku: text('sku'),
    ...provenance(),
  },
  (table) => [
    // What a line's (tenant_id, product_id) points at: a product of its own business.
    unique('orders_products_tenant_id_uq').on(table.tenantId, table.id),
    index('orders_products_tenant_name_idx').on(table.tenantId, table.name),
  ],
);
