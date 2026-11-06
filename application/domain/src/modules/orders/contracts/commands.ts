import { CurrencyCode, commandSpec, MoneyInput } from '@hykr/contracts';
import { z } from 'zod';
import { OrderItemView, OrderView } from './order.js';

/**
 * One item of an order as a save sends it: flat, each naming the group it sits in by `ref`, so
 * any depth fits in a plain list.
 */
export const SaveOrderItem = z.object({
  ref: z
    .string()
    .min(1)
    .max(40)
    .describe('Your key for this item, unique in the request: "1", "kitchen"'),
  parent: z.string().min(1).max(40).optional().describe('The ref of the group it sits in'),
  id: z.uuid().optional().describe('The id of an item the order already has, to keep it'),
  kind: z.enum(['group', 'line']).default('line'),
  title: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(1_000_000).optional().describe('A line only; default 1'),
  unitPrice: MoneyInput.optional().describe('A line only: a decimal string such as "1500.00"'),
  taxRateBp: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe('A line only: its tax rate in basis points, 1800 for 18%'),
  cost: MoneyInput.optional().describe('What the line costs the business'),
});
export type SaveOrderItem = z.infer<typeof SaveOrderItem>;

export const SaveOrderInput = z.object({
  orderId: z.uuid().optional().describe('To change an existing order; leave out for a new one'),
  title: z.string().min(1).max(200),
  currency: CurrencyCode.optional().describe("A new order's currency; default the business's"),
  items: z.array(SaveOrderItem).max(1000),
});
export type SaveOrderInput = z.infer<typeof SaveOrderInput>;

export const SaveOrderResult = z.object({ order: OrderView, items: z.array(OrderItemView) });

export const SaveOrderSpec = commandSpec({
  name: 'order.save',
  description:
    'Save a whole order in one step: its title and every item, groups and priced lines. A new order gets the next number. Amounts are decimal strings in the order currency ("1500.00"). To change an order, send its orderId and every item to keep, with their ids; items left out are removed.',
  input: SaveOrderInput,
  output: SaveOrderResult,
  http: { method: 'POST', path: '/api/orders/save' },
  tool: 'save-order',
  expose: 'all',
  approvalNote:
    'When you call it, the save waits for the user; a large order waits for an owner in the app.',
  verb: { do: 'save', did: 'saved' },
  touches: ['order', 'orderItem'],
});

export const CancelOrderSpec = commandSpec({
  name: 'order.cancel',
  description: 'Cancel an order. Its number stays taken: orders are never deleted.',
  input: z.object({ orderId: z.uuid() }),
  output: OrderView,
  http: { method: 'POST', path: '/api/orders/:orderId/cancel' },
  tool: 'cancel-order',
  expose: 'all',
  approvalNote: 'When you call it, the cancel waits for the user to approve it.',
  view: { name: 'order.card', id: (input) => input.orderId },
  verb: { do: 'cancel', did: 'cancelled' },
  touches: ['order'],
});
