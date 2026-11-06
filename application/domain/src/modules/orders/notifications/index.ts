/**
 * The orders module's WhatsApp templates and notifications (defineTemplate,
 * defineNotification from @hykr/notifications). Isomorphic.
 */
import type { Labels } from '@hykr/i18n';
import {
  type CommentMentionRow,
  defineNotification,
  type NotificationsDomain,
} from '@hykr/notifications';

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
  templates: [],
  notifications: [OrderMentionNotification],
};
