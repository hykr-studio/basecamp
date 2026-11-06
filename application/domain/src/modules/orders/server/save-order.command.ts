import {
  type AuthorizeResult,
  applyTax,
  buildTree,
  CurrencyMismatch,
  type Money,
  mulDiv,
  resolveMoneyInput,
  sumMoney,
  type TaxTotals,
  TreeError,
  type TreeNode,
} from '@hykr/contracts';
import {
  type ChildNode,
  defineCommand,
  deny,
  type NamedEvent,
  nextNumber,
  tenantMoney,
  tenantOf,
} from '@hykr/core';
import { moneyText } from '@hykr/i18n';
import { type SaveOrderInput, type SaveOrderItem, SaveOrderSpec } from '../contracts/index.js';
import { Order, OrderItem } from './order.entity.js';
import { saveDecision } from './policy.js';
import { OrderSeries } from './series.js';
import { percentageTax, type TaxedLine } from './tax.js';

/** order.saved: an order was created or changed (a NamedEvent: notifications may follow it). */
export class OrderSaved implements NamedEvent {
  readonly eventName = 'order.saved';
  constructor(readonly row: unknown) {}
}

type Node = ChildNode & { amount: Money };
interface Priced {
  currency: string;
  nodes: Node[];
  totals: TaxTotals;
  lineCount: number;
}

class Invalid extends Error {}

/**
 * The order's items as a tree, each line's amount (quantity × unit price), each group's sum,
 * and the tax lines from the module's percentage function. A save's input either prices
 * cleanly or is refused with the reason.
 */
export function price(input: SaveOrderInput, currency: string): Priced | AuthorizeResult {
  try {
    const tree = buildTree(input.items, { key: 'ref', parent: 'parent' });
    const lines: TaxedLine[] = [];
    const money = (m: SaveOrderItem['unitPrice']) =>
      m === undefined ? null : resolveMoneyInput(m, currency);
    const toNode = (n: TreeNode<SaveOrderItem>): Node => {
      if (n.kind === 'line') {
        if (n.children.length) throw new Invalid(`"${n.title}" is a line: nothing goes under it`);
        const unitPrice = money(n.unitPrice);
        if (!unitPrice) throw new Invalid(`"${n.title}" needs a unit price`);
        const quantity = n.quantity ?? 1;
        const amount = { minor: mulDiv(unitPrice.minor, quantity, 1), currency };
        const taxRateBp = n.taxRateBp ?? 0;
        lines.push({ amount, taxRateBp });
        return {
          ...(n.id ? { id: n.id } : {}),
          kind: 'line',
          title: n.title,
          quantity,
          unitPrice,
          taxRateBp,
          amount,
          cost: money(n.cost),
          children: [],
        };
      }
      if (n.unitPrice !== undefined || n.quantity !== undefined)
        throw new Invalid(`"${n.title}" is a group: its lines carry the prices`);
      const children = n.children.map(toNode);
      return {
        ...(n.id ? { id: n.id } : {}),
        kind: 'group',
        title: n.title,
        quantity: null,
        unitPrice: null,
        taxRateBp: null,
        amount: sumMoney(
          children.map((c) => c.amount),
          currency,
        ),
        cost: null,
        children,
      };
    };
    const nodes = tree.map(toNode);
    return {
      currency,
      nodes,
      totals: applyTax(percentageTax, lines, { currency }),
      lineCount: lines.length,
    };
  } catch (e) {
    if (e instanceof Invalid || e instanceof TreeError)
      return deny('order_items_invalid', e.message);
    if (e instanceof CurrencyMismatch)
      return deny('currency_mismatch', `Every amount of an order is in ${currency}`);
    if (e instanceof RangeError || (e as Error).name === 'ZodError')
      return deny('money_invalid', (e as Error).message);
    throw e;
  }
}

const refused = (x: Priced | AuthorizeResult): x is AuthorizeResult => 'decision' in x;

/** The order's currency: an existing order's own; a new one's from the input or the business. */
function currencyOf(input: SaveOrderInput, loaded: Loaded): string | AuthorizeResult {
  if (loaded.order) {
    if (input.currency && input.currency !== loaded.order.currency)
      return deny('currency_fixed', `This order is in ${loaded.order.currency}`);
    return loaded.order.currency;
  }
  return input.currency ?? loaded.money.currency;
}

type Loaded = {
  order: typeof Order.table.$inferSelect | null;
  money: Awaited<ReturnType<typeof tenantMoney>>;
};

/**
 * Save a whole order in one write: a new order takes the next number of the orders series (in
 * run, so a save that waits for approval takes none until it runs); then its items are made
 * exactly the tree sent (kept, changed, moved, added, removed) and its totals stored.
 */
export const SaveOrder = defineCommand(SaveOrderSpec, {
  resource: { type: 'order', id: (input) => input.orderId ?? null },
  load: async (tx, p, input): Promise<Loaded> => ({
    order: input.orderId ? await Order.repo.get(tx, p, input.orderId) : null,
    money: await tenantMoney(tx, tenantOf(p)),
  }),
  authorize: (p, loaded, input) => {
    if (loaded.order?.status === 'cancelled')
      return deny('order_cancelled', 'This order is cancelled');
    const currency = currencyOf(input, loaded);
    if (typeof currency !== 'string') return currency;
    const priced = price(input, currency);
    if (refused(priced)) return priced;
    return saveDecision(p, priced.totals.total, loaded.money);
  },
  summarize: (input, loaded) => {
    const currency = currencyOf(input, loaded);
    const priced = typeof currency === 'string' ? price(input, currency) : null;
    const total = priced && !refused(priced) ? `, ${moneyText(priced.totals.total)}` : '';
    const what = loaded.order ? `order ${loaded.order.number}` : `a new order "${input.title}"`;
    return `Save ${what}: ${input.items.length} item${input.items.length === 1 ? '' : 's'}${total}`;
  },
  run: async ({ tx, principal, input, loaded, via }) => {
    const currency = currencyOf(input, loaded) as string;
    const priced = price(input, currency) as Priced;
    const totals = {
      subtotal: priced.totals.subtotal,
      taxTotal: priced.totals.taxTotal,
      total: priced.totals.total,
      taxLines: priced.totals.taxLines,
      lineCount: priced.lineCount,
    };
    let order: typeof Order.table.$inferSelect;
    if (loaded.order) {
      order = await Order.repo.update(
        tx,
        principal,
        loaded.order,
        { title: input.title, ...totals },
        via,
      );
    } else {
      const { number } = await nextNumber(tx, principal, OrderSeries);
      order = await Order.repo.insert(
        tx,
        principal,
        { number, title: input.title, currency, ...totals },
        via,
      );
    }
    const items = await OrderItem.children.replace(tx, principal, order, priced.nodes, via);
    return {
      value: { order, items: items.rows },
      touched: [
        {
          type: 'order',
          id: order.id,
          change: loaded.order ? 'updated' : 'created',
          ...(loaded.order ? { before: loaded.order } : {}),
          after: order,
        },
        ...items.touched,
      ],
      events: [new OrderSaved(order)],
    };
  },
});
