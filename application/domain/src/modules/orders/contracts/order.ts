import { CreatedBy, CurrencyCode, entitySpec, Money, MoneyInput, TaxLine } from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);

/** An order: its number from the module's series, its totals in minor units, its tax lines. */
export const OrderView = z.object({
  id: z.string(),
  /** ORD/2026-27/0001: from the orders series, gapless per business. */
  number: z.string(),
  title,
  status: z.enum(['open', 'cancelled']),
  currency: CurrencyCode,
  subtotal: Money,
  taxTotal: Money,
  total: Money,
  taxLines: z.array(TaxLine),
  /** How many priced lines it has (groups not counted). */
  lineCount: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrderView = z.infer<typeof OrderView>;

const totals = {
  subtotal: MoneyInput,
  taxTotal: MoneyInput,
  total: MoneyInput,
  taxLines: z.array(TaxLine),
  lineCount: z.number().int().min(0),
};

/** Written only by order.save and order.cancel (plain CRUD writes are internal). */
export const CreateOrderInput = z.object({
  number: z.string(),
  title,
  currency: CurrencyCode,
  ...totals,
});
export const UpdateOrderInput = z.object({
  title: title.optional(),
  status: z.enum(['open', 'cancelled']).optional(),
  subtotal: MoneyInput.optional(),
  taxTotal: MoneyInput.optional(),
  total: MoneyInput.optional(),
  taxLines: z.array(TaxLine).optional(),
  lineCount: z.number().int().min(0).optional(),
});

export const OrderSpec = entitySpec({
  name: 'order',
  label: 'order',
  description:
    'Orders: a numbered list of groups and priced lines, with tax and totals. Read them here; save a whole order with save-order.',
  schemas: { read: OrderView, create: CreateOrderInput, update: UpdateOrderInput },
  fieldLabels: {
    number: { en: 'Number', hi: 'नंबर', te: 'నంబర్' },
    title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' },
    total: { en: 'Total', hi: 'कुल', te: 'మొత్తం' },
    status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
  },
  list: {
    filterable: { status: 'enum', total: 'money', number: 'text', createdAt: 'date' },
    sortable: ['createdAt', 'total', 'number'],
    defaultSort: [['createdAt', 'desc']],
    search: ['title', 'number'],
    pageSize: { default: 25, max: 100 },
    examples: { total: '{ "gte": 100000 } (minor units)', status: '"open"' },
  },
  // Orders change only through their commands: a whole save, a cancel. Never deleted.
  expose: { list: 'all', get: 'all', create: 'internal', update: 'internal', delete: 'internal' },
  traits: {
    money: { fields: ['subtotal', 'taxTotal', 'total'] },
    // A comment the assistant adds where a customer could read it waits for the person; a
    // team-only one goes at once.
    comments: {
      approval: (p, { input }) => p.actor.kind === 'agent' && input?.internal !== true,
    },
  },
  views: { list: 'order.list', item: 'order.card' },
});

/** One node of an order: a group (a heading with lines under it) or a priced line. */
export const OrderItemView = z.object({
  id: z.string(),
  orderId: z.string(),
  parentItemId: z.string().nullable(),
  position: z.number().int(),
  kind: z.enum(['group', 'line']),
  title,
  quantity: z.number().int().nullable(),
  unitPrice: Money.nullable(),
  /** The line's tax rate in basis points (1800 is 18%). */
  taxRateBp: z.number().int().nullable(),
  /** A line's quantity × unit price; a group's lines added up. */
  amount: Money,
  /** What it costs the business: hidden without orders.cost.read. */
  cost: Money.nullable().optional(),
  currency: CurrencyCode,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type OrderItemView = z.infer<typeof OrderItemView>;

const itemFields = {
  kind: z.enum(['group', 'line']),
  title,
  quantity: z.number().int().min(1).nullable().optional(),
  unitPrice: MoneyInput.nullable().optional(),
  taxRateBp: z.number().int().min(0).max(10_000).nullable().optional(),
  amount: MoneyInput,
  cost: MoneyInput.nullable().optional(),
};

export const OrderItemSpec = entitySpec({
  name: 'orderItem',
  label: 'order item',
  description: "An order's groups and lines, in a tree. Filter by orderId.",
  schemas: {
    read: OrderItemView,
    create: z.object(itemFields),
    update: z.object({
      ...itemFields,
      kind: itemFields.kind.optional(),
      title: title.optional(),
      amount: MoneyInput.optional(),
      parentItemId: z.string().nullable().optional(),
      position: z.number().int().min(0).optional(),
    }),
  },
  fieldLabels: {
    title: { en: 'Item', hi: 'आइटम', te: 'ఐటమ్' },
    quantity: { en: 'Quantity', hi: 'मात्रा', te: 'పరిమాణం' },
    unitPrice: { en: 'Unit price', hi: 'इकाई मूल्य', te: 'యూనిట్ ధర' },
    amount: { en: 'Amount', hi: 'राशि', te: 'మొత్తం' },
  },
  list: {
    filterable: { orderId: 'id', kind: 'enum' },
    sortable: ['position'],
    defaultSort: [['position', 'asc']],
    pageSize: { default: 200, max: 1000 },
  },
  expose: { list: 'all', get: 'all', create: 'internal', update: 'internal', delete: 'internal' },
  traits: {
    money: { fields: ['unitPrice', 'amount', 'cost'] },
    parent: { entity: 'order', field: 'orderId', nest: 'parentItemId', position: 'position' },
  },
});
