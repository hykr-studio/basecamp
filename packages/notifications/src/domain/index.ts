/**
 * THE DOMAIN's templates and notifications (meetings and to-dos). Replace this folder to bring
 * another domain; the framework reads only `domainTemplates` and `domainNotifications`.
 */
import { type Lang, pick, spokenWhen } from '@app/i18n';
import { z } from 'zod';
import { defineNotification, type Row } from '../define-notification.js';
import { defineTemplate } from '../define-template.js';

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

export const TodoDue = defineTemplate({
  name: 'todo_due_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(80) }),
  body: {
    en: 'Due today: {{title}}.',
    hi: 'आज करना है: {{title}}।',
    te: 'ఈరోజు చేయాల్సింది: {{title}}.',
  },
  example: { title: 'Order tiles' },
});

type MeetingRow = Row & {
  title: string;
  startsAt: string;
  status: string;
  ownerId: string;
  customerId: string | null;
};
type TodoRow = Row & {
  title: string;
  dueOn: string | null;
  done: boolean;
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
const DUE = { en: 'is due today', hi: 'आज करना है', te: 'ఈరోజు చేయాలి' } as const;

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

/** At 9am (IST) on the day a to-do is due, unless it is done by then. */
export const TodoDueNotification = defineNotification<TodoRow>({
  key: 'todo.due',
  topic: 'reminders',
  schedule: {
    on: ['todo.created', 'todo.updated'],
    at: (t) => (t.dueOn && !t.done ? new Date(`${t.dueOn}T09:00:00+05:30`) : null),
    cancelOn: ['todo.deleted'],
  },
  to: (t) => [...(t.customerId ? [{ customerId: t.customerId }] : []), { userId: t.ownerId }],
  channels: ['whatsapp', 'email'],
  whatsapp: { template: TodoDue, params: (t) => ({ title: t.title }) },
  email: {
    subject: (t, r) => SUBJECT[r.lang](t.title),
    body: (t, r) => `${t.title} ${pick(DUE, r.lang)}.`,
  },
  dedupe: (t) => `todo.due:${t.id}`,
});

export const domainTemplates = [MeetingReminder, TodoDue];
// biome-ignore lint/suspicious/noExplicitAny: notifications over different rows
export const domainNotifications: ReturnType<typeof defineNotification<any>>[] = [
  MeetingReminderNotification,
  TodoDueNotification,
];
