/**
 * The framework's own notifications: a request waiting for the business's decision, and its
 * outcome told back to the customer who asked. Any domain gets them.
 */
import type { Lang } from '@app/i18n';
import { defineNotification, type Row } from '../define-notification.js';
import { ApprovalOutcome, ApprovalRequest } from './templates.js';

type ApprovalRow = Row & {
  summary: string | null;
  status: string;
  approverUserId: string | null;
  approverRoles: string[];
  approverChannels: string[] | null;
  requesterContactId: string | null;
};

const OUTCOME: Record<string, Record<Lang, string>> = {
  approved: { en: 'approved', hi: 'मंज़ूर हुआ', te: 'అనుమతించబడింది' },
  rejected: { en: 'not approved', hi: 'मंज़ूर नहीं हुआ', te: 'అనుమతించబడలేదు' },
  expired: { en: 'not decided in time', hi: 'समय पर तय नहीं हुआ', te: 'సమయానికి నిర్ణయించబడలేదు' },
};

/**
 * Someone else's request (a customer's) waits for the business: its deciders get it on
 * WhatsApp with Approve and Reject, unless the action may only be decided in the app. A
 * person's own assistant asks them in the conversation instead.
 */
export const ApprovalRequestNotification = defineNotification<ApprovalRow>({
  key: 'approval.request',
  topic: 'service',
  send: { on: ['approval.requested'] },
  when: (a) =>
    !a.approverUserId && (!a.approverChannels || a.approverChannels.includes('whatsapp')),
  to: (a) => [{ roles: a.approverRoles }],
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
