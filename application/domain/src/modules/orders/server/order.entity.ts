import { defineChildEntity, defineEntity, deny } from '@hykr/core';
import { BUSINESS_ACCESS, readByParticipants } from '../../../server/access.js';
import { OrderItemSpec, OrderSpec, ProductSpec, SupplierRole } from '../contracts/index.js';
import { orderItems, orders, products } from '../db/schema.js';

/**
 * Orders: written only by order.save (a draft), their transitions (order.transition) and
 * order.revise, never deleted (a number, once given, stays taken), with the domain's usual
 * access, and read by the organisation that supplies one. The states and versioned traits do
 * the rest: a submitted order is frozen, a stale save is 409.
 */
export const Order = defineEntity(OrderSpec, {
  table: orders,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: readByParticipants([SupplierRole.name]),
  rules: [
    (_p, action) =>
      action === 'delete'
        ? deny(
            'orders_are_cancelled',
            'An order is cancelled, never deleted: its number stays taken',
          )
        : null,
    (_p, _action, _row, input, ctx) => {
      if (ctx.via === 'order.save' && input?.status === undefined) return null;
      if (ctx.via === 'order.transition' || ctx.via === 'order.revise') return null;
      return deny(
        'orders_saved_whole',
        'An order changes only by saving it whole, by its transitions, or by a revision',
      );
    },
  ],
  summarize: (action, input, row) =>
    `${action === 'create' ? 'Create' : action === 'update' ? 'Change' : 'Delete'} order ${String(input?.number ?? row?.number ?? '')}`,
});

/**
 * An order's groups and lines: children of the order (traits.parent), written whole by
 * order.save. They take the order's owner, customer and currency, and its access: its supplier
 * reads them (without their cost, `costHidden`).
 */
export const OrderItem = defineChildEntity(OrderItemSpec, {
  table: orderItems,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: {
    read: {
      ...BUSINESS_ACCESS.read,
      customer: [
        'customer',
        { grant: 'participant', of: 'order', via: 'orderId', as: [SupplierRole.name] },
      ],
    },
    write: BUSINESS_ACCESS.write,
  },
  parent: { def: Order, owner: (t) => t.ownerId, customer: (t) => t.customerId },
});

/**
 * The business's products: the whole team reads them (an order's line may name one), owners,
 * admins and ops change them. Someone outside the team reads none, so a line's product reads to
 * them as `{ id, label: null }`.
 */
export const Product = defineEntity(ProductSpec, {
  table: products,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: {
    read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'tenant' },
    write: { owner: 'tenant', admin: 'tenant', ops: 'tenant' },
  },
});
