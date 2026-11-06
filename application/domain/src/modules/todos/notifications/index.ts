/** The to-dos module's WhatsApp template and its reminder on the day a to-do is due. */
import { type Lang, pick } from '@hykr/i18n';
import { defineNotification, defineTemplate, type Row } from '@hykr/notifications';
import { z } from 'zod';

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
const DUE = { en: 'is due today', hi: 'आज करना है', te: 'ఈరోజు చేయాలి' } as const;
const DUE_TODAY = { en: 'Due today', hi: 'आज करना है', te: 'ఈరోజు చేయాల్సింది' } as const;

/**
 * At 9am (IST) on the day a to-do is due, unless it is done by then: a push to the person's
 * phone first, then WhatsApp, then email (the fallback order is this list).
 */
export const TodoDueNotification = defineNotification<TodoRow>({
  key: 'todo.due',
  topic: 'reminders',
  schedule: {
    on: ['todo.created', 'todo.updated'],
    at: (t) => (t.dueOn && !t.done ? new Date(`${t.dueOn}T09:00:00+05:30`) : null),
    cancelOn: ['todo.deleted'],
  },
  to: (t) => [...(t.customerId ? [{ customerId: t.customerId }] : []), { userId: t.ownerId }],
  channels: ['push', 'whatsapp', 'email'],
  push: {
    title: (_t, r) => pick(DUE_TODAY, r.lang),
    body: (t) => t.title,
    url: () => '/todos',
  },
  whatsapp: { template: TodoDue, params: (t) => ({ title: t.title }) },
  email: {
    subject: (t, r) => SUBJECT[r.lang](t.title),
    body: (t, r) => `${t.title} ${pick(DUE, r.lang)}.`,
  },
  dedupe: (t) => `todo.due:${t.id}`,
});

export const todosNotifications = {
  templates: [TodoDue],
  notifications: [TodoDueNotification],
};
