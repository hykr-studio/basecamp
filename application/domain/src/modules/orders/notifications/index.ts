/**
 * The orders module's WhatsApp templates and notifications (defineTemplate,
 * defineNotification from @hykr/notifications). Isomorphic.
 */
import { defineTemplate, type NotificationsDomain } from '@hykr/notifications';
import { z } from 'zod';

/** An order's PDF on WhatsApp: the document in the header, its number and total in the body. */
export const OrderDocumentTemplate = defineTemplate({
  name: 'order_document_v1',
  category: 'utility',
  params: z.object({ number: z.string().max(40), total: z.string().max(40) }),
  header: { type: 'document' },
  body: {
    en: 'Here is your order {{number}}, for {{total}}.',
    hi: 'आपका ऑर्डर {{number}}, {{total}} का, संलग्न है।',
    te: 'మీ ఆర్డర్ {{number}}, {{total}}, జతచేయబడింది.',
  },
  example: { number: 'ORD/2026-27/0001', total: '₹1,500.00' },
});

export const ordersNotifications: NotificationsDomain = {
  templates: [OrderDocumentTemplate],
  notifications: [],
};
