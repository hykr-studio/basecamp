/**
 * The framework's own notifications: a request waiting for someone's decision, its outcome told
 * back to the customer who asked, and a person mentioned in a comment. Any domain gets them.
 */
import { type Labels, pick, t } from '@hykr/i18n';
import { defineNotification, type Row } from '../define-notification.js';
import { ApprovalOutcome, ApprovalRequest } from './templates.js';

type ApprovalRow = Row & {
  summary: string | null;
  status: string;
  ownerId: string | null;
  approverUserId: string | null;
  approverCapability: string | null;
  approverChannels: string[] | null;
  minAssurance: string | null;
  requesterContactId: string | null;
};

/** Is someone other than the requester to decide it (a capability's holders, or a named person)? */
const decidedByOthers = (a: ApprovalRow) =>
  a.approverUserId ? a.approverUserId !== a.ownerId : !!a.approverCapability;

/**
 * May its Approve and Reject buttons decide it on WhatsApp? Only where its channels allow
 * WhatsApp, and when it asks for no more than a number (a tap is only as sure as that).
 */
export const decidableOnWhatsApp = (a: Pick<ApprovalRow, 'approverChannels' | 'minAssurance'>) =>
  (!a.approverChannels || a.approverChannels.includes('whatsapp')) &&
  (!a.minAssurance || a.minAssurance === 'whatsapp_number');

/** Where the app shows it: the decider decides there, the requester follows it. */
const pathOf = (a: Pick<ApprovalRow, 'id'>) => `/approvals/${encodeURIComponent(a.id)}`;
const summaryOf = (a: Pick<ApprovalRow, 'summary'>) => (a.summary ?? '').slice(0, 200);

const OUTCOME: Record<string, Labels> = {
  approved: { en: 'approved', hi: 'मंज़ूर हुआ', te: 'అనుమతించబడింది' },
  rejected: { en: 'not approved', hi: 'मंज़ूर नहीं हुआ', te: 'అనుమతించబడలేదు' },
  expired: { en: 'not decided in time', hi: 'समय पर तय नहीं हुआ', te: 'సమయానికి నిర్ణయించబడలేదు' },
};

/**
 * A request someone else decides (a customer's, or one the policy sends to a capability or a
 * named person): its deciders are asked, never the requester. It is always kept in each
 * decider's in-app inbox, and reaches them by push, else on WhatsApp with Approve and Reject
 * (only where it may be decided there), else by email. Each opens `/approvals/<id>`. A person's
 * own assistant asks them in the conversation instead. An application changes the order with
 * `overrideNotification('approval.request', { channels, also })`.
 */
export const ApprovalRequestNotification = defineNotification<ApprovalRow>({
  key: 'approval.request',
  topic: 'service',
  send: { on: ['approval.requested'] },
  when: decidedByOthers,
  to: (a) =>
    a.approverUserId
      ? [{ userId: a.approverUserId }]
      : a.approverCapability
        ? [{ capability: a.approverCapability, except: a.ownerId ? [a.ownerId] : [] }]
        : [],
  channels: ['push', 'whatsapp', 'email'],
  also: ['inapp'],
  channelWhen: { whatsapp: decidableOnWhatsApp },
  push: {
    title: (_a, r) => t(r.lang, 'approval.waiting'),
    body: summaryOf,
    url: pathOf,
  },
  inapp: {
    title: (_a, r) => t(r.lang, 'approval.waiting'),
    body: summaryOf,
    url: pathOf,
  },
  whatsapp: {
    template: ApprovalRequest,
    params: (a) => ({ summary: summaryOf(a) }),
  },
  email: {
    subject: (a, r) => t(r.lang, 'approval.requestSubject', { summary: summaryOf(a) }),
    body: (a, r) =>
      t(r.lang, 'approval.requestBody', {
        summary: summaryOf(a),
        url: `${r.appUrl ?? ''}${pathOf(a)}`,
      }),
  },
  approval: (a) => a.id,
  dedupe: (a) => `approval.request:${a.id}`,
});

/** The customer who asked hears how it ended (a failed replay is the business's to explain). */
export const ApprovalOutcomeNotification = defineNotification<ApprovalRow>({
  key: 'approval.outcome',
  topic: 'service',
  send: { on: ['approval.decided'] },
  when: (a) => !!a.requesterContactId && a.status in OUTCOME,
  to: (a) => (a.requesterContactId ? [{ contactId: a.requesterContactId }] : []),
  channels: ['whatsapp'],
  whatsapp: {
    template: ApprovalOutcome,
    params: (a, r) => ({
      summary: summaryOf(a),
      outcome: OUTCOME[a.status] ? pick(OUTCOME[a.status], r.lang) : a.status,
    }),
  },
  dedupe: (a) => `approval.outcome:${a.id}`,
});

/** A `comment.mentioned` event's row: one person (or agent) a comment names. */
export type CommentMentionRow = Row & {
  commentId: string;
  on: { entity: string; id: string };
  target: { kind: string; id: string; label: string };
  author: { id: string | null; name: string | null };
  internal: boolean;
  /** The comment's first characters, mentions shown as @Name. */
  excerpt: string;
};

/**
 * A person named in a comment finds it in their in-app inbox, with a link to the record. The
 * framework sends nothing outside the app on its own: an application that wants push or email
 * for mentions declares its own notification on `comment.mentioned`.
 */
export const CommentMentionNotification = defineNotification<CommentMentionRow>({
  key: 'comment.mention',
  topic: 'service',
  send: { on: ['comment.mentioned'] },
  when: (m) => m.target.kind === 'user',
  to: (m) => [{ userId: m.target.id }],
  channels: ['inapp'],
  inapp: {
    title: (m, r) =>
      t(r.lang, 'comments.mentioned', { name: m.author.name ?? t(r.lang, 'comments.someone') }),
    body: (m) => m.excerpt,
    record: (m) => ({ type: m.on.entity, id: m.on.id }),
  },
  dedupe: (m) => `comment.mention:${m.commentId}:${m.target.kind}:${m.target.id}`,
});

export const frameworkNotifications = [
  ApprovalRequestNotification,
  ApprovalOutcomeNotification,
  CommentMentionNotification,
];
