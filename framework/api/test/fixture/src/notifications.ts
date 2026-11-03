import { spokenWhen } from '@hykr/i18n';
import { defineNotification, defineTemplate, type Row } from '@hykr/notifications';
import { z } from 'zod';

export const VisitReminder = defineTemplate({
  name: 'visit_reminder_v1',
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

export const TaskDue = defineTemplate({
  name: 'task_due_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(80) }),
  body: { en: 'Due today: {{title}}.', hi: 'आज करना है: {{title}}।', te: 'ఈరోజు: {{title}}.' },
  example: { title: 'Order tiles' },
});

type VisitRow = Row & {
  title: string;
  startsAt: string;
  ownerId: string;
  customerId: string | null;
};

/** 30 minutes before a visit, to its customer and its owner. A reschedule moves it. */
export const VisitReminderNotification = defineNotification<VisitRow>({
  key: 'visit.reminder',
  topic: 'reminders',
  schedule: {
    on: ['visit.created', 'visit.updated', 'visit.rescheduled'],
    at: (v) => new Date(new Date(v.startsAt).getTime() - 30 * 60_000),
    cancelOn: ['visit.deleted'],
  },
  to: (v) => [...(v.customerId ? [{ customerId: v.customerId }] : []), { userId: v.ownerId }],
  channels: ['whatsapp', 'email'],
  whatsapp: {
    template: VisitReminder,
    params: (v, r) => ({ title: v.title, time: spokenWhen(v.startsAt, r.timeZone, r.lang) }),
  },
  email: {
    subject: (v) => `Reminder: ${v.title}`,
    body: (v, r) => `${v.title} starts at ${spokenWhen(v.startsAt, r.timeZone, r.lang)}.`,
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
  dedupe: (v) => `visit.reminder:${v.id}`,
});

export const fixtureNotifications = {
  templates: [VisitReminder, TaskDue],
  notifications: [VisitReminderNotification],
};
