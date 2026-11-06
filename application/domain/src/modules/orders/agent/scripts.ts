import { call, defineScript, items, say, sayIn, written } from '@hykr/agents/script';
import { moneyText } from '@hykr/i18n';

/**
 * The scripted model's knowledge of the orders module (tests, CI and demos without a key):
 *   order <title>: <qty> <item> at <price> [+<rate>%], …     save-order (waits for approval)
 *   list orders                                               list-orders
 * Prices are decimals in the business's currency; a rate is the line's tax percentage.
 */
const first = (text: string) => text.split('\n')[0]?.trim() ?? '';
const ORDER = /^order\s+(.+?):\s*(.+)$/i;
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

export const ordersScripts = [
  defineScript({
    name: 'order',
    match: parse,
    step: ({ title, lines }, turn) => {
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
