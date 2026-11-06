/**
 * The framework's own notifications: a request waiting for the business's decision, and its
 * outcome told back to the customer who asked. Any domain gets them.
 */
import type { Lang } from '@hykr/i18n';
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

export const frameworkNotifications = [ApprovalRequestNotification, ApprovalOutcomeNotification];
