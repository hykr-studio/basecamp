/**
 * The framework's own notifications: a request waiting for the business's decision, its outcome
 * told back to the customer who asked, and a person mentioned in a comment. Any domain gets them.
 */
import { type Lang, t } from '@hykr/i18n';
import { defineNotification, type Row } from '../define-notification.js';
import { ApprovalOutcome, ApprovalRequest } from './templates.js';

type ApprovalRow = Row & {
  summary: string | null;
  status: string;
  ownerId: string | null;
  approverUserId: string | null;
  approverCapability: string | null;
  approverChannels: string[] | null;
  requesterContactId: string | null;
};

/** Is someone other than the requester to decide it (a capability's holders, or a named person)? */
const decidedByOthers = (a: ApprovalRow) =>
  a.approverUserId ? a.approverUserId !== a.ownerId : !!a.approverCapability;

const OUTCOME: Record<string, Record<Lang, string>> = {
  approved: { en: 'approved', hi: 'मंज़ूर हुआ', te: 'అనుమతించబడింది' },
  rejected: { en: 'not approved', hi: 'मंज़ूर नहीं हुआ', te: 'అనుమతించబడలేదు' },
  expired: { en: 'not decided in time', hi: 'समय पर तय नहीं हुआ', te: 'సమయానికి నిర్ణయించబడలేదు' },
};

/**
 * A request someone else decides (a customer's, or one the policy sends to a capability or a
 * named person): its deciders get it on WhatsApp with Approve and Reject, never the requester,
 * unless the action may only be decided in the app. A person's own assistant asks them in the
 * conversation instead.
 */
export const ApprovalRequestNotification = defineNotification<ApprovalRow>({
  key: 'approval.request',
  topic: 'service',
  send: { on: ['approval.requested'] },
  when: (a) =>
    decidedByOthers(a) && (!a.approverChannels || a.approverChannels.includes('whatsapp')),
  to: (a) =>
    a.approverUserId
      ? [{ userId: a.approverUserId }]
      : a.approverCapability
        ? [{ capability: a.approverCapability, except: a.ownerId ? [a.ownerId] : [] }]
        : [],
  channels: ['whatsapp'],
  whatsapp: {
    template: ApprovalRequest,
    params: (a) => ({ summary: (a.summary ?? '').slice(0, 200) }),
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
      summary: (a.summary ?? '').slice(0, 200),
      outcome: OUTCOME[a.status]?.[r.lang] ?? a.status,
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
