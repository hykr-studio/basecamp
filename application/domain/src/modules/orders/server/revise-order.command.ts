import {
  allow,
  defineCommand,
  deny,
  type NamedEvent,
  needsApproval,
  reviseWithChildren,
  transition,
} from '@hykr/core';
import { ReviseOrderSpec } from '../contracts/index.js';
import type { orderItems } from '../db/schema.js';
import { Order } from './order.entity.js';

/** order.revised: a new revision of an order, a draft; the row is the new revision. */
export class OrderRevised implements NamedEvent {
  readonly eventName = 'order.revised';
  constructor(
    readonly row: unknown,
    readonly before: unknown,
  ) {}
}

/** "ORD/2026-27/0007-v3" → "ORD/2026-27/0007": the series' own number. */
const firstNumber = (number: string) => number.replace(/-v\d+$/, '');

/**
 * Change a submitted (or expired) order: its next revision is a draft copy of it with every
 * item, numbered "<first number>-v<n>" (no series number is spent on it), and the old one is
 * superseded, frozen as it was. An approved order is the contract: it is never revised. The
 * assistant's revise waits for the person, pinned to the version it was asked on.
 */
export const ReviseOrder = defineCommand(ReviseOrderSpec, {
  resource: { type: 'order', id: (input) => input.orderId },
  load: (tx, p, input) => Order.repo.get(tx, p, input.orderId),
  pin: (order) => [{ def: Order, row: order }],
  authorize: (p, order) => {
    if (order.status !== 'submitted' && order.status !== 'expired')
      return deny(
        'order_revise_submitted',
        order.status === 'draft'
          ? 'A draft is changed by saving it; only a submitted order is revised'
          : `This order is ${order.status}: it can't be revised`,
      );
    return p.actor.kind === 'agent'
      ? needsApproval('agent_revises_order', 'Revising an order for you needs your approval', {
          tier: 2,
        })
      : allow('person_revises_order');
  },
  summarize: (_input, order) => `Revise order ${order.number} (v${order.revision})`,
  run: async ({ tx, principal, loaded: order, via }) => {
    const next = await reviseWithChildren(tx, principal, Order, order, {
      via,
      values: (revision) => ({ number: `${firstNumber(order.number)}-v${revision}` }),
    });
    const old = await transition(tx, principal, Order, order, 'supersede', { via });
    const revised = next.row as typeof Order.table.$inferSelect;
    return {
      value: {
        order: revised,
        items: (next.children.orderItem ?? []) as (typeof orderItems.$inferSelect)[],
      },
      touched: [...next.touched, ...old.touched],
      events: [...old.events, new OrderRevised(revised, order)],
    };
  },
});
