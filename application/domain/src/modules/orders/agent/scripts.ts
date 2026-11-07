import { call, defineScript, items, type Outcome, say, sayIn, written } from '@hykr/agents/script';
import { moneyText } from '@hykr/i18n';

/**
 * The scripted model's knowledge of the orders module (tests, CI and demos without a key):
 *   order <title>: <qty> <item> at <price> [+<rate>%], …     list-orders → save-order (waits)
 *   list orders                                               list-orders
 *   cancel order <number>                                     list-orders → cancel-order (waits)
 *   orders by status / order totals by month                  summarize-orders (kpi.row tiles)
 * Prices are decimals in the business's currency; a rate is the line's tax percentage.
 */
const first = (text: string) => text.split('\n')[0]?.trim() ?? '';
const ORDER = /^order\s+(.+?):\s*(.+)$/i;
const CANCEL = /^cancel order\s+(\S+)$/i;
const ITEM = /^(\d+)\s+(.+?)\s+at\s+(\d+(?:\.\d{1,3})?)(?:\s*\+\s*(\d+(?:\.\d{1,2})?)%)?$/i;

type Line = { title: string; quantity: number; unitPrice: string; taxRateBp?: number };

function parse(text: string): { title: string; lines: Line[] } | undefined {
  const m = ORDER.exec(first(text));
  if (!m) return undefined;
  const lines: Line[] = [];
  for (const part of m[2].split(',')) {
    const x = ITEM.exec(part.trim());
    if (!x) return undefined;
    lines.push({
      title: x[2],
      quantity: Number(x[1]),
      unitPrice: x[3],
      ...(x[4] ? { taxRateBp: Math.round(Number(x[4]) * 100) } : {}),
    });
  }
  return lines.length ? { title: m[1], lines } : undefined;
}

type Saved = { order: { number: string; total: { minor: number; currency: string } } };

/** The summaries the scripted model asks for: the tiles show them, computed for the reader. */
const SUMMARIES: Record<string, Record<string, unknown>> = {
  'orders by status': { groupBy: ['status'], sum: ['total'] },
  'order totals by month': {
    groupBy: ['createdAt:month'],
    sum: ['total'],
    sort: '-key',
    limit: 4,
  },
};

/** How many orders a summary counted (its totals are one bucket per currency). */
const counted = (o: Outcome) =>
  ((o.result as { totals?: { count: number }[] } | undefined)?.totals ?? []).reduce(
    (n, t) => n + t.count,
    0,
  );

export const ordersScripts = [
  defineScript({
    name: 'order',
    match: parse,
    step: ({ title, lines }, turn) => {
      // Look first (the assistant never writes blind), then save a new order whole.
      if (!turn.result('list-orders')) return [call('list-orders', { q: title })];
      const r = turn.result('save-order');
      if (!r)
        return [
          call('save-order', {
            title,
            items: lines.map((l, i) => ({ ref: String(i + 1), kind: 'line', ...l })),
          }),
        ];
      return [
        say(
          written(
            r,
            (v) => {
              const o = (v as unknown as Saved).order;
              return `Saved order ${o.number}: ${moneyText(o.total, turn.lang)}.`;
            },
            turn,
          ),
        ),
      ];
    },
  }),
  defineScript({
    name: 'cancel-order',
    match: (text) => CANCEL.exec(first(text))?.[1],
    step: (number, turn) => {
      const cancelled = turn.result('cancel-order');
      if (cancelled) return [say(written(cancelled, () => `Cancelled order ${number}.`, turn))];
      const found = turn.result('list-orders');
      if (!found) return [call('list-orders', { number })];
      const [order] = items(found) as unknown as { id: string }[];
      // Never an invented id: no such order, no cancel.
      if (!order)
        return [
          sayIn(turn, {
            en: `There is no order ${number}.`,
            hi: `ऑर्डर ${number} नहीं मिला।`,
            te: `ఆర్డర్ ${number} లేదు.`,
          }),
        ];
      return [call('cancel-order', { orderId: order.id })];
    },
  }),
  defineScript({
    name: 'summarize-orders',
    match: (text) => SUMMARIES[first(text).toLowerCase()],
    step: (query, turn) => {
      const r = turn.result('summarize-orders');
      if (!r) return [call('summarize-orders', query)];
      if (!r.ok)
        return [
          sayIn(turn, {
            en: "I couldn't total your orders.",
            hi: 'मैं आपके ऑर्डर का जोड़ नहीं निकाल सका।',
            te: 'మీ ఆర్డర్ల మొత్తం లెక్కించలేకపోయాను.',
          }),
        ];
      const n = counted(r);
      return [
        sayIn(turn, {
          en: `${n} ${n === 1 ? 'order' : 'orders'} in all; the totals are above.`,
          hi: `कुल ${n} ऑर्डर; जोड़ ऊपर है।`,
          te: `మొత్తం ${n} ఆర్డర్లు; మొత్తాలు పైన ఉన్నాయి.`,
        }),
      ];
    },
  }),
  defineScript({
    name: 'list-orders',
    match: (text) => (/^list orders$/i.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-orders');
      if (!r) return [call('list-orders', {})];
      const orders = items(r) as unknown as {
        number: string;
        title: string;
        total: { minor: number; currency: string };
      }[];
      if (orders.length === 0)
        return [
          sayIn(turn, {
            en: 'You have no orders.',
            hi: 'आपके कोई ऑर्डर नहीं हैं।',
            te: 'మీకు ఆర్డర్లు ఏవీ లేవు.',
          }),
        ];
      return [
        say(
          orders.map((o) => `${o.number} ${o.title}: ${moneyText(o.total, turn.lang)}`).join('\n'),
        ),
      ];
    },
  }),
];
