import {
  CreatedBy,
  CurrencyCode,
  entitySpec,
  Money,
  MoneyInput,
  type StatesTrait,
  TaxLine,
  type VersionedTrait,
} from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);

/** Where an order stands. Only its transitions move it (ORDER_STATES). */
export const OrderStatus = z.enum([
  'draft',
  'submitted',
  'approved',
  'accepted',
  'fulfilled',
  'cancelled',
  'superseded',
  'expired',
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

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

/** An order: its number from the module's series, its totals in minor units, its tax lines. */
export const OrderView = z.object({
  id: z.string(),
  /** ORD/2026-27/0001: from the orders series, gapless per business. */
  number: z.string(),
  title,
  status: OrderStatus,
  /** Why it was cancelled, when it was. */
  cancelReason: z.string().nullable(),
  /** Counts its writes: a save sent with an older one is refused (409). */
  version: z.number().int(),
  /** Its first revision's id (null on the first), and which revision it is: 1, 2, 3. */
  seriesId: z.string().nullable(),
  revision: z.number().int(),
  currency: CurrencyCode,
  subtotal: Money,
  taxTotal: Money,
  total: Money,
  taxLines: z.array(TaxLine),
  /** How many priced lines it has (groups not counted). */
  lineCount: z.number().int(),
  /**
   * Its groups and lines, in tree order: only on its `order.placed` event, so an outside system
   * gets the whole order in one delivery (each line's cost hidden without orders.cost.read).
   * Reads list them with /api/orderItems.
   */
  items: z.array(OrderItemView).optional(),
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

/** Written only by order.save, its transitions and order.revise (plain CRUD writes are internal). */
export const CreateOrderInput = z.object({
  number: z.string(),
  title,
  currency: CurrencyCode,
  ...totals,
});
export const UpdateOrderInput = z.object({
  title: title.optional(),
  status: OrderStatus.optional(),
  cancelReason: z.string().min(1).max(500).optional(),
  version: z.number().int().optional(),
  subtotal: MoneyInput.optional(),
  taxTotal: MoneyInput.optional(),
  total: MoneyInput.optional(),
  taxLines: z.array(TaxLine).optional(),
  lineCount: z.number().int().min(0).optional(),
});

const label = (en: string, hi: string, te: string) => ({ en, hi, te });
const agentAsks = (p: { actor: { kind: string } }) => p.actor.kind === 'agent';

/**
 * An order's life: a draft is saved and changed freely; submitted, it is frozen and waits for a
 * decision (an owner is told after 24 business hours, and it expires after a week); approved,
 * it is the contract; accepted (its customer accepted its PDF with a one-time code,
 * OrderAcceptance), it is placed with its supplier until it is fulfilled. To change a submitted
 * order, revise it: v2 is a draft, and v1 is superseded. The assistant's moves wait for the
 * person; its approve waits for an owner, signed in to the app.
 */
export const ORDER_STATES: StatesTrait = {
  field: 'status',
  initial: 'draft',
  states: {
    draft: { label: label('Draft', 'ड्राफ़्ट', 'డ్రాఫ్ట్') },
    submitted: { label: label('Submitted', 'भेजा गया', 'సమర్పించబడింది') },
    approved: { label: label('Approved', 'मंज़ूर', 'ఆమోదించబడింది') },
    accepted: { label: label('Accepted', 'स्वीकृत', 'అంగీకరించబడింది') },
    fulfilled: { label: label('Fulfilled', 'पूरा', 'పూర్తయింది'), terminal: true },
    cancelled: { label: label('Cancelled', 'रद्द', 'రద్దు చేయబడింది'), terminal: true },
    superseded: { label: label('Superseded', 'बदला गया', 'భర్తీ చేయబడింది'), terminal: true },
    expired: { label: label('Expired', 'समय समाप्त', 'గడువు ముగిసింది') },
  },
  transitions: [
    {
      name: 'submit',
      from: 'draft',
      to: 'submitted',
      label: label('Submit', 'भेजें', 'సమర్పించు'),
      approval: agentAsks,
    },
    {
      name: 'approve',
      from: 'submitted',
      to: 'approved',
      label: label('Approve', 'मंज़ूर करें', 'ఆమోదించు'),
      can: 'orders.approve',
      // The assistant's approve waits for the person it acts for (who may approve orders), in
      // the app, signed in, at the application's `irreversible` level: an approved order is
      // the contract.
      approval: {
        when: agentAsks,
        by: 'requester',
        channels: ['app'],
        minAssurance: 'session',
        level: 'irreversible',
      },
    },
    {
      // People (an approved order its customer accepted on paper, too) and the supplier's
      // verified report (the orders-supplier connector); never the assistant.
      name: 'fulfil',
      from: ['approved', 'accepted'],
      to: 'fulfilled',
      label: label('Mark fulfilled', 'पूरा करें', 'పూర్తి చేయి'),
      expose: 'human',
    },
    {
      name: 'cancel',
      from: ['draft', 'submitted', 'approved', 'accepted'],
      to: 'cancelled',
      label: label('Cancel', 'रद्द करें', 'రద్దు చేయి'),
      fields: ['cancelReason'],
      approval: agentAsks,
      // A cancelled order never comes back: an outside AI client is told it cannot be undone.
      destructive: true,
    },
    // The server's own moves: the expiry SLA, order.revise freezing the old revision, and the
    // customer's acceptance of the approved order's PDF (OrderAcceptance runs it).
    { name: 'expire', from: 'submitted', to: 'expired', expose: 'system' },
    { name: 'supersede', from: ['submitted', 'expired'], to: 'superseded', expose: 'system' },
    { name: 'accept', from: 'approved', to: 'accepted', expose: 'system' },
  ],
  slas: [
    {
      name: 'orders.decision',
      state: 'submitted',
      within: '24h',
      hours: 'business',
      // Whoever may approve orders hears that one is waiting.
      escalate: { notify: ['orders.approve'] },
    },
    {
      name: 'orders.expiry',
      state: 'submitted',
      within: '168h',
      escalate: { transition: 'expire' },
    },
  ],
};

/** Frozen once submitted: v2 is made by revising; an approved or accepted order is the contract. */
export const ORDER_VERSIONS: VersionedTrait = {
  frozenWhen: {
    status: [
      'submitted',
      'approved',
      'accepted',
      'fulfilled',
      'cancelled',
      'superseded',
      'expired',
    ],
  },
  revisions: {},
};

export const OrderSpec = entitySpec({
  name: 'order',
  label: 'order',
  description:
    'Orders: a numbered list of groups and priced lines, with tax and totals. Read them here; save a whole draft with save-order, move one with transition-orders (submit, approve, cancel), and change a submitted one with revise-order.',
  schemas: { read: OrderView, create: CreateOrderInput, update: UpdateOrderInput },
  fieldLabels: {
    number: { en: 'Number', hi: 'नंबर', te: 'నంబర్' },
    title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' },
    total: { en: 'Total', hi: 'कुल', te: 'మొత్తం' },
    status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
    cancelReason: { en: 'Why it was cancelled', hi: 'रद्द करने का कारण', te: 'రద్దు చేసిన కారణం' },
    revision: { en: 'Revision', hi: 'संशोधन', te: 'సవరణ' },
  },
  list: {
    filterable: { status: 'enum', total: 'money', number: 'text', createdAt: 'date' },
    sortable: ['createdAt', 'total', 'number'],
    defaultSort: [['createdAt', 'desc']],
    search: ['title', 'number'],
    pageSize: { default: 25, max: 100 },
    examples: { total: '{ "gte": 100000 } (minor units)', status: '"submitted"' },
  },
  // Orders change only through a whole save, their transitions and a revision. Never deleted.
  expose: { list: 'all', get: 'all', create: 'internal', update: 'internal', delete: 'internal' },
  traits: {
    money: { fields: ['subtotal', 'taxTotal', 'total'] },
    states: ORDER_STATES,
    versioned: ORDER_VERSIONS,
  },
  views: { list: 'order.list', item: 'order.card' },
});

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
