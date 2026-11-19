import { defineShareable } from '@hykr/contracts';
import { OrderLinkTemplate } from '../notifications/index.js';
import { OrderDocument } from './document.js';

/**
 * An order may be shared by link (decisions B9): its customer (or anyone the business sends it
 * to) sees the order, its groups and lines (never their cost: the module's own projector and
 * field policy hide it from anyone without `orders.cost.read`), opens its PDF and, as the order's
 * customer reached on WhatsApp, accepts it with a code (OrderAcceptance). An order's link may
 * have no end date, where the business allows it (a job runs for months, then its warranty),
 * and is sent to its customer on WhatsApp (OrderLinkTemplate), else by email (decisions B23).
 */
export const OrderShare = defineShareable({
  entity: 'order',
  children: ['orderItem'],
  documents: [OrderDocument.name],
  acceptances: true,
  lasting: true,
  send: {
    whatsapp: {
      template: OrderLinkTemplate,
      params: (target) => ({
        business: target.business.name.slice(0, 60),
        number: String(target.record?.number ?? '').slice(0, 40),
      }),
    },
  },
});
