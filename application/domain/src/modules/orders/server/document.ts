import { defineDocument } from '@hykr/api';
import { buildTree, type Money, stateLabel, type TaxLine, type TreeNode } from '@hykr/contracts';
import { type Labels, moneyText } from '@hykr/i18n';
import { ORDER_STATES, type OrderStatus } from '../contracts/index.js';
import { OrderDocumentTemplate } from '../notifications/index.js';
import { OrderItem } from './order.entity.js';

/** What an order's PDF shows: never what its lines cost the business. */
export interface OrderDocumentData {
  order: {
    number: string;
    title: string;
    status: OrderStatus;
    currency: string;
    subtotal: Money;
    taxTotal: Money;
    total: Money;
    taxLines: TaxLine[];
    createdAt: string;
  };
  items: {
    id: string;
    parentItemId: string | null;
    position: number;
    kind: 'group' | 'line';
    title: string;
    quantity: number | null;
    unitPrice: Money | null;
    amount: Money;
  }[];
}

const L = {
  order: { en: 'Order', hi: 'ऑर्डर', te: 'ఆర్డర్' },
  number: { en: 'Number', hi: 'नंबर', te: 'నంబర్' },
  date: { en: 'Date', hi: 'तारीख', te: 'తేదీ' },
  title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' },
  status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
  item: { en: 'Item', hi: 'आइटम', te: 'ఐటమ్' },
  quantity: { en: 'Qty', hi: 'मात्रा', te: 'పరిమాణం' },
  unitPrice: { en: 'Unit price', hi: 'इकाई मूल्य', te: 'యూనిట్ ధర' },
  amount: { en: 'Amount', hi: 'राशि', te: 'మొత్తం' },
  subtotal: { en: 'Subtotal', hi: 'उप-योग', te: 'ఉప మొత్తం' },
  tax: { en: 'Tax', hi: 'कर', te: 'పన్ను' },
  total: { en: 'Total', hi: 'कुल', te: 'మొత్తం' },
  page: { en: 'Page {page} of {pages}', hi: 'पृष्ठ {page} / {pages}', te: 'పేజీ {page} / {pages}' },
  void: {
    en: 'This order was cancelled. Its number stays taken.',
    hi: 'यह ऑर्डर रद्द कर दिया गया था। इसका नंबर किसी और को नहीं मिलेगा।',
    te: 'ఈ ఆర్డర్ రద్దు చేయబడింది. దీని నంబర్ వేరే దానికి ఇవ్వబడదు.',
  },
  subject: { en: 'Order', hi: 'ऑर्डर', te: 'ఆర్డర్' },
  attached: {
    en: 'Your order {number}, for {total}, is attached.',
    hi: 'आपका ऑर्डर {number}, {total} का, संलग्न है।',
    te: 'మీ ఆర్డర్ {number}, {total}, జతచేయబడింది.',
  },
} satisfies Record<string, Labels>;

const words = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

/**
 * An order as a PDF, in English, Hindi or Telugu: its number, date and status, its groups and
 * lines (indented under their groups), its tax lines and totals. It shows nothing restricted
 * (never cost), so every colleague who reads the order opens every copy (`capabilities: []`).
 * Sent on WhatsApp as order_document_v1, or by email.
 */
export const OrderDocument = defineDocument<OrderDocumentData>({
  name: 'orders.order',
  label: L.order,
  entity: 'order',
  capabilities: [],
  load: async ({ record, children }) => {
    const items = await children(OrderItem);
    const o = record as unknown as OrderDocumentData['order'];
    return {
      order: {
        number: o.number,
        title: o.title,
        status: o.status,
        currency: o.currency,
        subtotal: o.subtotal,
        taxTotal: o.taxTotal,
        total: o.total,
        taxLines: o.taxLines,
        createdAt: o.createdAt,
      },
      // Only what a customer may see: an item's cost never leaves for a document.
      items: items.map((i) => ({
        id: String(i.id),
        parentItemId: (i.parentItemId as string | null) ?? null,
        position: Number(i.position),
        kind: i.kind as 'group' | 'line',
        title: String(i.title),
        quantity: (i.quantity as number | null) ?? null,
        unitPrice: (i.unitPrice as Money | null) ?? null,
        amount: i.amount as Money,
      })),
    };
  },
  render: ({ order, items }, ctx) => {
    type Item = OrderDocumentData['items'][number];
    const rows: { cells: string[]; kind: 'group' | 'line'; indent: number }[] = [];
    const walk = (nodes: TreeNode<Item>[], depth: number) => {
      for (const n of nodes) {
        rows.push(
          n.kind === 'group'
            ? { cells: [n.title, '', '', ctx.money(n.amount)], kind: 'group', indent: depth }
            : {
                cells: [
                  n.title,
                  String(n.quantity ?? 1),
                  n.unitPrice ? ctx.money(n.unitPrice) : '',
                  ctx.money(n.amount),
                ],
                kind: 'line',
                indent: depth,
              },
        );
        walk(n.children, depth + 1);
      }
    };
    walk(buildTree(items, { key: 'id', parent: 'parentItemId', order: 'position' }), 0);
    const title = `${ctx.label(L.order)} ${order.number}`;
    return {
      title,
      header: { left: ctx.business.name, right: order.number },
      footer: { left: order.title, right: ctx.label(L.page) },
      blocks: [
        { type: 'heading', text: title },
        {
          type: 'fields',
          items: [
            { label: ctx.label(L.number), value: order.number },
            { label: ctx.label(L.date), value: ctx.date(order.createdAt) },
            { label: ctx.label(L.title), value: order.title },
            // The state in the document's language, as the orders state machine names it.
            { label: ctx.label(L.status), value: stateLabel(ORDER_STATES, order.status, ctx.lang) },
          ],
        },
        ...(order.status === 'cancelled'
          ? [{ type: 'text' as const, text: ctx.label(L.void), bold: true }]
          : []),
        { type: 'spacer', size: 6 },
        {
          type: 'table',
          columns: [
            { label: ctx.label(L.item), width: 4 },
            { label: ctx.label(L.quantity), width: 0.8, align: 'right' },
            { label: ctx.label(L.unitPrice), width: 1.6, align: 'right' },
            { label: ctx.label(L.amount), width: 1.7, align: 'right' },
          ],
          rows,
        },
        {
          type: 'totals',
          rows: [
            { label: ctx.label(L.subtotal), value: ctx.money(order.subtotal) },
            ...order.taxLines.map((t) => ({
              label:
                t.rateBp !== undefined
                  ? `${ctx.label(L.tax)} ${t.rateBp / 100}%`
                  : (t.label ?? t.code),
              value: ctx.money(t.amount),
            })),
            { label: ctx.label(L.total), value: ctx.money(order.total), strong: true },
          ],
        },
      ],
    };
  },
  fileName: ({ order }) => order.number.replaceAll('/', '-'),
  send: {
    whatsapp: {
      template: OrderDocumentTemplate,
      params: ({ order }, reader) => ({
        number: order.number,
        total: moneyText(order.total, reader.lang),
      }),
    },
    email: {
      subject: ({ order }, reader) => `${L.subject[reader.lang]} ${order.number}`,
      body: ({ order }, reader) =>
        words(L.attached[reader.lang], {
          number: order.number,
          total: moneyText(order.total, reader.lang),
        }),
    },
  },
});
