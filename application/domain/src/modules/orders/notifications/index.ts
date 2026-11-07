/**
 * The orders module's WhatsApp templates and notifications (defineTemplate, defineNotification
 * from @hykr/notifications). Isomorphic. An SLA's escalation names who should hear about a
 * breach (contracts ORDER_STATES); this is how they hear it. Someone named in a comment on an
 * order hears of it too.
 */
import { type Labels, moneyText, pick } from '@hykr/i18n';
import {
  type CommentMentionRow,
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

/**
 * The breach event's row: the order with the SLA that ran out. Who hears it reads `sla` as
 * stored; the words read the order as each recipient may (its read shape: `total` is money).
 */
type BreachedOrder = Row & {
  number: string;
  title: string;
  total: { minor: number; currency: string };
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

const total = (o: BreachedOrder, lang: Parameters<typeof moneyText>[1]) => moneyText(o.total, lang);

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

const MENTIONED: Labels = {
  en: '{name} mentioned you on an order',
  hi: '{name} ने एक ऑर्डर पर आपका ज़िक्र किया',
  te: '{name} ఒక ఆర్డర్‌లో మిమ్మల్ని ప్రస్తావించారు',
};
const SOMEONE: Labels = { en: 'Someone', hi: 'किसी', te: 'ఎవరో' };

const said = (m: CommentMentionRow, lang: keyof Labels) =>
  MENTIONED[lang].replace('{name}', m.author.name ?? SOMEONE[lang]);

/**
 * Someone named in a comment on an order hears of it on their phone, else by email, with a
 * link to the order. (The framework's own notification also keeps it in their in-app inbox.)
 */
export const OrderMentionNotification = defineNotification<CommentMentionRow>({
  key: 'orders.comment-mention',
  topic: 'service',
  send: { on: ['comment.mentioned'] },
  when: (m) => m.on.entity === 'order' && m.target.kind === 'user',
  to: (m) => [{ userId: m.target.id }],
  channels: ['push', 'email'],
  push: {
    title: (m, r) => said(m, r.lang),
    body: (m) => m.excerpt,
    url: (m) => `/orders/${m.on.id}`,
  },
  email: {
    subject: (m, r) => said(m, r.lang),
    body: (m) => m.excerpt,
  },
  dedupe: (m) => `orders.comment-mention:${m.commentId}:${m.target.id}`,
});

export const ordersNotifications: NotificationsDomain = {
  templates: [OrderDocumentTemplate],
  notifications: [OrderDecisionOverdue, OrderMentionNotification],
};
