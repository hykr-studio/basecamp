import { call, defineScript, items, say, sayIn, written } from '@hykr/agents/script';
import { moneyText } from '@hykr/i18n';

/**
 * The scripted model's knowledge of the orders module (tests, CI and demos without a key):
 *   order <title>: <qty> <item> at <price> [+<rate>%], …     list-orders → save-order (waits)
 *   list orders                                               list-orders
 *   submit|approve|cancel order <number>                      list-orders → transition-orders
 *   revise order <number>                                     list-orders → revise-order (waits)
 * Prices are decimals in the business's currency; a rate is the line's tax percentage.
 */
const first = (text: string) => text.split('\n')[0]?.trim() ?? '';
const ORDER = /^order\s+(.+?):\s*(.+)$/i;
const MOVE = /^(submit|approve|cancel) order\s+(\S+)$/i;
const REVISE = /^revise order\s+(\S+)$/i;
const DID = { submit: 'Submitted', approve: 'Approved', cancel: 'Cancelled' } as const;

/** No order by that number: never an invented id. */
const noSuchOrder = (turn: Parameters<typeof sayIn>[0], number: string) =>
  sayIn(turn, {
    en: `There is no order ${number}.`,
    hi: `ऑर्डर ${number} नहीं मिला।`,
    te: `ఆర్డర్ ${number} లేదు.`,
  });
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
    name: 'move-order',
    match: (text) => {
      const m = MOVE.exec(first(text));
      return m ? { move: m[1].toLowerCase() as keyof typeof DID, number: m[2] } : undefined;
    },
    step: ({ move, number }, turn) => {
      const moved = turn.result('transition-orders');
      if (moved) return [say(written(moved, () => `${DID[move]} order ${number}.`, turn))];
      const found = turn.result('list-orders');
      if (!found) return [call('list-orders', { number })];
      const [order] = items(found) as unknown as { id: string }[];
      if (!order) return [noSuchOrder(turn, number)];
      return [call('transition-orders', { id: order.id, transition: move })];
    },
  }),
  defineScript({
    name: 'revise-order',
    match: (text) => REVISE.exec(first(text))?.[1],
    step: (number, turn) => {
      const revised = turn.result('revise-order');
      if (revised)
        return [
          say(
            written(
              revised,
              (v) => `Order ${(v as unknown as Saved).order.number} is a new draft of ${number}.`,
              turn,
            ),
          ),
        ];
      const found = turn.result('list-orders');
      if (!found) return [call('list-orders', { number })];
      const [order] = items(found) as unknown as { id: string }[];
      if (!order) return [noSuchOrder(turn, number)];
      return [call('revise-order', { orderId: order.id })];
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
