/**
 * The orders module's WhatsApp templates and notifications (defineTemplate, defineNotification
 * from @hykr/notifications). Isomorphic. An SLA's escalation names who should hear about a
 * breach (contracts ORDER_STATES); this is how they hear it.
 */
import { type Labels, moneyText, pick } from '@hykr/i18n';
import {
  defineNotification,
  defineTemplate,
  type NotificationsDomain,
  type Row,
} from '@hykr/notifications';
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

/** The breach event's row: the order as stored, with the SLA that ran out. */
type BreachedOrder = Row & {
  number: string;
  title: string;
  total: number;
  currency: string;
  sla: { id: string; name: string; dueAt: string; escalate: { notify?: string[] } | null };
};

const WAITING: Labels = {
  en: 'is waiting for a decision',
  hi: 'फ़ैसले का इंतज़ार कर रहा है',
  te: 'నిర్ణయం కోసం ఎదురుచూస్తోంది',
};
const SINCE: Labels = {
  en: 'It was submitted more than a working day ago.',
  hi: 'इसे एक कामकाजी दिन से पहले भेजा गया था।',
  te: 'దీన్ని ఒక పని దినం కంటే ముందు సమర్పించారు.',
};

const total = (o: BreachedOrder, lang: Parameters<typeof moneyText>[1]) =>
  moneyText({ minor: o.total, currency: o.currency }, lang);

/**
 * A submitted order nobody decided within its `orders.decision` SLA (24 business hours): to the
 * people the SLA escalates to (whoever may approve orders), on their phone, else by email.
 */
export const OrderDecisionOverdue = defineNotification<BreachedOrder>({
  key: 'order.decision-overdue',
  topic: 'service',
  send: { on: ['order.sla.breached'] },
  when: (o) => o.sla?.name === 'orders.decision',
  to: (o) => (o.sla.escalate?.notify ?? ['orders.approve']).map((capability) => ({ capability })),
  channels: ['push', 'email'],
  push: {
    title: (o, r) => `${o.number} ${pick(WAITING, r.lang)}`,
    body: (o, r) => `${o.title}: ${total(o, r.lang)}`,
    url: (o) => `/orders/${o.id}`,
  },
  email: {
    subject: (o, r) => `${o.number} ${pick(WAITING, r.lang)}`,
    body: (o, r) => `${o.title}: ${total(o, r.lang)}. ${pick(SINCE, r.lang)}`,
  },
  dedupe: (o) => `order.decision-overdue:${o.sla.id}`,
});

export const ordersNotifications: NotificationsDomain = {
  templates: [OrderDocumentTemplate],
  notifications: [OrderDecisionOverdue],
};
