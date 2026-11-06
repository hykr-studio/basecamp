import { type Labels, moneyText, pick, spokenMoney } from '@hykr/i18n';
import { action, defineView, spokenList, type ViewLabels } from '@hykr/ui-registry';
import { z } from 'zod';
import { OrderSpec, OrderView } from '../contracts/index.js';

const open = action<OrderView>({ screen: 'order.detail', params: (o) => ({ id: o.id }) });

const STATUS: Record<OrderView['status'], Labels> = {
  open: { en: 'open', hi: 'खुला', te: 'తెరిచి ఉంది' },
  cancelled: { en: 'cancelled', hi: 'रद्द', te: 'రద్దు చేయబడింది' },
};
const WORDS = {
  lines: { en: 'Lines', hi: 'लाइनें', te: 'లైన్లు' },
  subtotal: { en: 'Subtotal', hi: 'उप-योग', te: 'ఉప మొత్తం' },
  total: { en: 'Total', hi: 'कुल', te: 'మొత్తం' },
} satisfies Record<string, Labels>;

const noun = {
  en: ['order', 'orders'],
  hi: ['ऑर्डर', 'ऑर्डर'],
  te: ['ఆర్డర్', 'ఆర్డర్లు'],
} as const;
const labels = {
  title: { en: 'Orders', hi: 'ऑर्डर', te: 'ఆర్డర్లు' },
  empty: { en: 'No orders.', hi: 'कोई ऑर्डर नहीं।', te: 'ఆర్డర్లు ఏవీ లేవు.' },
  noun,
} satisfies ViewLabels;

export const OrderCardView = defineView({
  name: 'order.card',
  description: 'One order: its number, title, status, tax and total, and a way to open it.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ id: z.string(), item: OrderView }),
  source: { entity: OrderSpec, into: 'item', by: 'id' },
  actions: { open },
  labels: { noun },
  text: (p, ctx) =>
    [
      `${p.item.number} · ${p.item.title}${p.item.status === 'open' ? '' : ` (${pick(STATUS[p.item.status], ctx.lang)})`}`,
      `${pick(WORDS.lines, ctx.lang)}: ${p.item.lineCount}`,
      `${pick(WORDS.subtotal, ctx.lang)}: ${moneyText(p.item.subtotal, ctx.lang)}`,
      ...p.item.taxLines.map((t) => `${t.label ?? t.code}: ${moneyText(t.amount, ctx.lang)}`),
      `${pick(WORDS.total, ctx.lang)}: ${moneyText(p.item.total, ctx.lang)}`,
    ].join('\n'),
  speak: (p, ctx) => `${p.item.title}, ${spokenMoney(p.item.total, ctx.lang)}.`,
});

export const OrderListView = defineView({
  name: 'order.list',
  description: 'A list of orders, newest first, each with its number and total.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(OrderView) }),
  source: { entity: OrderSpec, into: 'items' },
  actions: { open },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [
          p.title,
          ...p.items.map(
            (o) =>
              `• ${o.number} ${o.title}: ${moneyText(o.total, ctx.lang)}${o.status === 'open' ? '' : ` (${pick(STATUS[o.status], ctx.lang)})`}`,
          ),
        ]
          .filter(Boolean)
          .join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((o) => o.title),
      labels,
      ctx,
    ),
});
