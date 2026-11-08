import { type NamedEvent, systemPrincipal, type Tx } from '@hykr/core';
import { OrderItem } from './order.entity.js';

type Values = Record<string, unknown>;

/**
 * order.placed: its customer accepted the order, so it is placed (with its supplier, in the
 * business's books). Stored in the accepting transaction. Its record is the order as stored, with
 * `items`: every group and line in tree order, as stored. Each reader gets it through the order's
 * read schema and projection, so a line's cost leaves only for whoever may read it (`costHidden`):
 * a webhook endpoint given orders.cost.read gets it, any other endpoint does not.
 */
export class OrderPlaced implements NamedEvent {
  readonly eventName = 'order.placed';
  readonly resourceType = 'order';
  constructor(readonly row: Values) {}
  get resourceId(): string {
    return String(this.row.id);
  }
}

/**
 * The order.placed event for this stored order. Its lines are read as the business's system
 * (whoever accepted may be a guest with a link, who reaches the order through the link only).
 */
export async function orderPlaced(tx: Tx, order: Values): Promise<OrderPlaced> {
  const business = systemPrincipal({ tenantId: String(order.tenantId), job: 'orders.placed' });
  const rows = await OrderItem.children.list(tx, business, String(order.id));
  return new OrderPlaced({
    ...order,
    items: rows.map((row) => OrderItem.readJson(row as Values)),
  });
}
