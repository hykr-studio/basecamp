import { defineShareable } from '@hykr/contracts';
import { OrderDocument } from './document.js';

/**
 * An order may be shared by link (decisions B9): its customer (or anyone the business sends it
 * to) sees the order, its groups and lines (never their cost: the module's own projector and
 * field policy hide it from anyone without `orders.cost.read`), opens its PDF and, as the order's
 * customer reached on WhatsApp, accepts it with a code (OrderAcceptance).
 */
export const OrderShare = defineShareable({
  entity: 'order',
  children: ['orderItem'],
  documents: [OrderDocument.name],
  acceptances: true,
});
