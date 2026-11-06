/** The meetings module's WhatsApp template and its reminder before each meeting. */
import { type Lang, pick, spokenWhen } from '@hykr/i18n';
import { defineNotification, defineTemplate, type Row } from '@hykr/notifications';
import { z } from 'zod';

export const MeetingReminder = defineTemplate({
  name: 'meeting_reminder_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(60), time: z.string().max(60) }),
  body: {
    en: 'Reminder: {{title}} at {{time}}.',
    hi: 'रिमाइंडर: {{title}} {{time}} पर है।',
    te: 'రిమైండర్: {{title}} {{time}}కి ఉంది.',
  },
  buttons: [
    {
      type: 'quick_reply',
      id: 'snooze_15',
      text: { en: 'Snooze 15 min', hi: '15 मिनट बाद', te: '15 నిమిషాల తర్వాత' },
    },
  ],
  example: { title: 'Site visit', time: '4:30 pm' },
});

type MeetingRow = Row & {
  title: string;
  startsAt: string;
  status: string;
  ownerId: string;
  customerId: string | null;
};
const SUBJECT: Record<Lang, (title: string) => string> = {
  en: (title) => `Reminder: ${title}`,
  hi: (title) => `रिमाइंडर: ${title}`,
  te: (title) => `రిమైండర్: ${title}`,
};
const SOON = {
  en: 'starts in 30 minutes',
  hi: '30 मिनट में शुरू होगी',
  te: '30 నిమిషాల్లో ప్రారంభమవుతుంది',
} as const;

/** 30 minutes before a meeting, to its customer and its owner. A reschedule moves it. */
export const MeetingReminderNotification = defineNotification<MeetingRow>({
  key: 'meeting.reminder',
  topic: 'reminders',
  schedule: {
    on: ['meeting.created', 'meeting.updated', 'meeting.rescheduled'],
    at: (m) =>
      m.status === 'scheduled' ? new Date(new Date(m.startsAt).getTime() - 30 * 60_000) : null,
    cancelOn: ['meeting.deleted', 'meeting.closed'],
  },
  to: (m) => [...(m.customerId ? [{ customerId: m.customerId }] : []), { userId: m.ownerId }],
  channels: ['whatsapp', 'email'],
  whatsapp: {
    template: MeetingReminder,
    params: (m, r) => ({ title: m.title, time: spokenWhen(m.startsAt, r.timeZone, r.lang) }),
  },
  email: {
    subject: (m, r) => SUBJECT[r.lang](m.title),
    body: (m, r) =>
      `${m.title} ${pick(SOON, r.lang)}: ${spokenWhen(m.startsAt, r.timeZone, r.lang)}.`,
  },
  onButton: {
    snooze_15: () => ({
      reschedule: new Date(Date.now() + 15 * 60_000),
      reply: {
        en: "Okay, I'll remind you again in 15 minutes.",
        hi: 'ठीक है, मैं 15 मिनट बाद फिर याद दिलाऊँगा।',
        te: 'సరే, 15 నిమిషాల తర్వాత మళ్లీ గుర్తు చేస్తాను.',
      },
    }),
  },
  dedupe: (m) => `meeting.reminder:${m.id}`,
});

export const meetingsNotifications = {
  templates: [MeetingReminder],
  notifications: [MeetingReminderNotification],
};
