import { allow, defineCommand, deny, type NamedEvent, needsApproval } from '@hykr/core';
import { CancelOrderSpec } from '../contracts/index.js';
import { Order } from './order.entity.js';

/** order.cancelled: the order stays, with its number; only its status changes. */
export class OrderCancelled implements NamedEvent {
  readonly eventName = 'order.cancelled';
  constructor(
    readonly row: unknown,
    readonly before: unknown,
  ) {}
}

/** Cancel an order instead of deleting it, so its number is never given again. */
export const CancelOrder = defineCommand(CancelOrderSpec, {
  resource: { type: 'order', id: (input) => input.orderId },
  load: (tx, p, input) => Order.repo.get(tx, p, input.orderId),
  authorize: (p, order) => {
    if (order.status === 'cancelled')
      return deny('order_cancelled', 'This order is already cancelled');
    if (p.actor.kind === 'agent')
      return needsApproval('agent_cancels_order', 'Cancelling an order needs your approval', {
        tier: 2,
      });
    return allow('person_cancels_order');
  },
  summarize: (_input, order) => `Cancel order ${order.number} (${order.title})`,
  run: async ({ tx, principal, loaded: order, via }) => {
    const cancelled = await Order.repo.update(tx, principal, order, { status: 'cancelled' }, via);
    return {
      value: cancelled,
      touched: [
        { type: 'order', id: order.id, change: 'updated', before: order, after: cancelled },
      ],
      events: [new OrderCancelled(cancelled, order)],
    };
  },
});
