/**
 * The framework's own notifications: a request waiting for someone's decision, its outcome told
 * back to the customer who asked, a person mentioned in a comment, and a connection made by
 * signing in that stopped working or soon will. Any domain gets them.
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

/** A `connection.needs_reauth` or `connection.reauth_soon` event's row (decisions B21). */
export type ConnectionReauthRow = Row & {
  connector: string;
  label: string;
  reason?: string;
  /** When the grant ends (`connection.reauth_soon`). */
  expiresAt?: string;
};

/** Where a business manages its connections, in the app. */
const INTEGRATIONS_PATH = '/integrations';
/** Who keeps a business's connections working: holders of `integrations.manage`. */
const MANAGERS = 'integrations.manage';

/**
 * A connection made by signing in stopped working (the provider no longer takes its grant):
 * the people who manage the business's integrations find it in their inbox and by email, with
 * a link to sign it in again. Nothing arrives from it until then.
 */
export const ConnectionNeedsReauthNotification = defineNotification<ConnectionReauthRow>({
  key: 'connection.needs_reauth',
  topic: 'service',
  send: { on: ['connection.needs_reauth'] },
  to: () => [{ capability: MANAGERS }],
  channels: ['email'],
  also: ['inapp'],
  inapp: {
    title: (c, r) => t(r.lang, 'integrations.needsReauth', { label: c.label }),
    body: (c, r) => t(r.lang, 'integrations.needsReauthBody', { label: c.label }),
    url: () => INTEGRATIONS_PATH,
  },
  email: {
    subject: (c, r) => t(r.lang, 'integrations.needsReauth', { label: c.label }),
    body: (c, r) =>
      t(r.lang, 'integrations.needsReauthEmail', {
        label: c.label,
        url: `${r.appUrl ?? ''}${INTEGRATIONS_PATH}`,
      }),
  },
  dedupe: (c) => `connection.needs_reauth:${c.id}:${c.reason ?? ''}`,
});

/** A grant that does not refresh ends within a week: its managers are told once, ahead. */
export const ConnectionReauthSoonNotification = defineNotification<ConnectionReauthRow>({
  key: 'connection.reauth_soon',
  topic: 'service',
  send: { on: ['connection.reauth_soon'] },
  to: () => [{ capability: MANAGERS }],
  channels: ['email'],
  also: ['inapp'],
  inapp: {
    title: (c, r) => t(r.lang, 'integrations.reauthSoon', { label: c.label }),
    body: (c, r) =>
      t(r.lang, 'integrations.reauthSoonBody', {
        label: c.label,
        date: (c.expiresAt ?? '').slice(0, 10),
      }),
    url: () => INTEGRATIONS_PATH,
  },
  email: {
    subject: (c, r) => t(r.lang, 'integrations.reauthSoon', { label: c.label }),
    body: (c, r) =>
      t(r.lang, 'integrations.reauthSoonEmail', {
        label: c.label,
        date: (c.expiresAt ?? '').slice(0, 10),
        url: `${r.appUrl ?? ''}${INTEGRATIONS_PATH}`,
      }),
  },
  dedupe: (c) => `connection.reauth_soon:${c.id}:${c.expiresAt ?? ''}`,
});

export const frameworkNotifications = [
  ApprovalRequestNotification,
  ApprovalOutcomeNotification,
  CommentMentionNotification,
  ConnectionNeedsReauthNotification,
  ConnectionReauthSoonNotification,
];
