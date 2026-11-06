/**
 * The orders module's notifications (defineNotification from @hykr/notifications). Isomorphic.
 * An SLA's escalation names who should hear about a breach (contracts ORDER_STATES); this is
 * how they hear it.
 */
import { type Labels, moneyText, pick } from '@hykr/i18n';
import { defineNotification, type NotificationsDomain, type Row } from '@hykr/notifications';

/** The breach event's row: the order as stored, with the SLA that ran out. */
type BreachedOrder = Row & {
  number: string;
  title: string;
  total: number;
  currency: string;
  sla: { id: string; name: string; dueAt: string; escalate: { roles?: string[] } | null };
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
 * roles the SLA escalates to, on their phone, else by email.
 */
export const OrderDecisionOverdue = defineNotification<BreachedOrder>({
  key: 'order.decision-overdue',
  topic: 'service',
  send: { on: ['order.sla.breached'] },
  when: (o) => o.sla?.name === 'orders.decision',
  to: (o) => [{ roles: [...(o.sla.escalate?.roles ?? ['owner'])] }],
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
  templates: [],
  notifications: [OrderDecisionOverdue],
};
