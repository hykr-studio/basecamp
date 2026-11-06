import { defineChildEntity, defineEntity, deny } from '@hykr/core';
import { BUSINESS_ACCESS } from '../../../server/access.js';
import { OrderItemSpec, OrderSpec } from '../contracts/index.js';
import { orderItems, orders } from '../db/schema.js';

/**
 * Orders: written only by order.save and order.cancel, never deleted (a number, once given,
 * stays taken), with the domain's usual access.
 */
export const Order = defineEntity(OrderSpec, {
  table: orders,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
  rules: [
    (_p, action) =>
      action === 'delete'
        ? deny(
            'orders_are_cancelled',
            'An order is cancelled, never deleted: its number stays taken',
          )
        : null,
    (_p, action, _row, input, ctx) => {
      if (ctx.via === 'order.save' && input?.status === undefined) return null;
      if (ctx.via === 'order.cancel' && action === 'update') return null;
      return deny(
        'orders_saved_whole',
        'An order changes only by saving it whole, or cancelling it',
      );
    },
  ],
  summarize: (action, input, row) =>
    `${action === 'create' ? 'Create' : action === 'update' ? 'Change' : 'Delete'} order ${String(input?.number ?? row?.number ?? '')}`,
});

/**
 * An order's groups and lines: children of the order (traits.parent), written whole by
 * order.save. They take the order's owner, customer and currency, and its access.
 */
export const OrderItem = defineChildEntity(OrderItemSpec, {
  table: orderItems,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
  parent: { def: Order, owner: (t) => t.ownerId, customer: (t) => t.customerId },
});
