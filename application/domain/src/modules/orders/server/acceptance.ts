import { defineAcceptance } from '@hykr/api';
import type { Labels } from '@hykr/i18n';
import type { OrderDocumentData } from './document.js';
import { orderPlaced } from './placed.js';

const L = {
  label: { en: 'Accept the order', hi: 'ऑर्डर स्वीकार करें', te: 'ఆర్డర్‌ను అంగీకరించండి' },
  statement: {
    en: 'I accept order {number}, "{title}", for {total}, as shown in this PDF.',
    hi: 'मैं ऑर्डर {number}, "{title}", {total} का, इस PDF में दिखाए अनुसार स्वीकार करता/करती हूँ।',
    te: 'ఈ PDFలో చూపినట్లుగా, {total}కు ఆర్డర్ {number}, "{title}"ని నేను అంగీకరిస్తున్నాను.',
  },
} satisfies Record<string, Labels>;

const words = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

/**
 * An approved order is accepted by its customer, with a one-time code to their WhatsApp number
 * (else their email), against the order's PDF (orders.order): exactly that PDF, of the order as
 * it is now. Accepting moves the order to `accepted` (the system transition `accept`, in the same
 * transaction), which is frozen: it is the contract. And it places the order: `order.placed`,
 * with its lines, for the business's webhook endpoints (its supplier, its books). An accepted
 * order is not accepted again, whatever PDF of it is made later (docs/decisions/H5.md).
 */
export const OrderAcceptance = defineAcceptance<OrderDocumentData>({
  name: 'orders.order',
  document: 'orders.order',
  label: L.label,
  statement: ({ order }, ctx) =>
    words(ctx.label(L.statement), {
      number: order.number,
      title: order.title,
      total: ctx.money(order.total),
    }),
  by: 'customer',
  channels: ['whatsapp', 'email'],
  transition: 'accept',
  when: (row) => {
    if (row.status === 'approved') return null;
    if (row.status === 'accepted')
      return { rule: 'order_accepted', reason: 'This order is accepted already' };
    return { rule: 'order_not_approved', reason: 'Only an approved order is accepted' };
  },
  accepted: async ({ tx, row }) => ({ events: [await orderPlaced(tx, row)] }),
});
