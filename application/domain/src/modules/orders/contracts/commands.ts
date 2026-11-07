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
  orderId: z.uuid().optional().describe('To change a draft order; leave out for a new one'),
  version: z
    .number()
    .int()
    .optional()
    .describe('The version of the order you read: a save over a newer one is refused'),
  title: z.string().min(1).max(200),
  currency: CurrencyCode.optional().describe("A new order's currency; default the business's"),
  items: z.array(SaveOrderItem).max(1000),
});
export type SaveOrderInput = z.infer<typeof SaveOrderInput>;

export const SaveOrderResult = z.object({ order: OrderView, items: z.array(OrderItemView) });

export const SaveOrderSpec = commandSpec({
  name: 'order.save',
  description:
    'Save a whole order in one step: its title and every item, groups and priced lines. A new order gets the next number and starts as a draft. Amounts are decimal strings in the order currency ("1500.00"). To change a draft, send its orderId and every item to keep, with their ids; items left out are removed. A submitted order is frozen: revise it instead.',
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

export const ReviseOrderSpec = commandSpec({
  name: 'order.revise',
  description:
    'Change a submitted (or expired) order by making its next revision: a draft copy of it with every item, numbered <number>-v2, -v3. The old revision is superseded and stays as it was.',
  input: z.object({ orderId: z.uuid() }),
  output: SaveOrderResult,
  http: { method: 'POST', path: '/api/orders/:orderId/revise' },
  tool: 'revise-order',
  expose: 'all',
  approvalNote: 'When you call it, the revision waits for the user to approve it.',
  verb: { do: 'revise', did: 'revised' },
  touches: ['order', 'orderItem'],
});
