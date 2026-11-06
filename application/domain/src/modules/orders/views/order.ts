import { pick } from '@hykr/i18n';
import { defineView, spokenList, type ViewLabels } from '@hykr/ui-registry';
import { z } from 'zod';
import { OrderSpec, OrderView } from '../contracts/index.js';

// TODO: translate. The Hindi and Telugu words are English placeholders.
const labels = {
  title: { en: 'Orders', hi: 'Orders', te: 'Orders' },
  empty: { en: 'No orders.', hi: 'No orders.', te: 'No orders.' },
  noun: {
    en: ['order', 'orders'],
    hi: ['order', 'orders'],
    te: ['order', 'orders'],
  },
} satisfies ViewLabels;

export const OrderListView = defineView({
  name: 'order.list',
  description: 'A list of orders, newest first.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(OrderView) }),
  source: { entity: OrderSpec, into: 'items' },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((x) => `• ${x.title}`)].filter(Boolean).join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((x) => x.title),
      labels,
      ctx,
    ),
});
