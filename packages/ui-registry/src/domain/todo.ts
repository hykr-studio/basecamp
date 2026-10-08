import { Todo, TodoSpec } from '@app/contracts';
import { dayText, type Labels, pick } from '@app/i18n';
import { z } from 'zod';
import {
  action,
  defineView,
  spokenList,
  type TextContext,
  type ViewLabels,
} from '../define-view.js';

const line = (t: Todo, ctx: TextContext) =>
  `${t.done ? '✓' : '•'} ${t.title}${t.dueOn ? ` (${pick(DUE, ctx.lang)} ${dayText(t.dueOn, ctx.lang)})` : ''}`;
const toggle = action<Todo>({
  command: 'todo.update',
  args: (t) => ({ id: t.id, done: !t.done }),
});

const labels = {
  title: { en: 'To-dos', hi: 'काम', te: 'పనులు' },
  empty: { en: 'No to-dos.', hi: 'कोई काम नहीं।', te: 'పనులు ఏవీ లేవు.' },
  noun: { en: ['to-do', 'to-dos'], hi: ['काम', 'काम'], te: ['పని', 'పనులు'] },
} satisfies ViewLabels;
const DONE: Labels = { en: 'done', hi: 'पूरा', te: 'పూర్తయింది' };
const DUE: Labels = { en: 'due', hi: 'आखिरी तारीख', te: 'గడువు' };

export const TodoListView = defineView({
  name: 'todo.list',
  description:
    'A checklist of to-dos the person can tick. Use for any list of tasks, including "what is due". Not for a single to-do (todo.item).',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Todo) }),
  source: { entity: TodoSpec, into: 'items' },
  actions: { toggle },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((t) => line(t, ctx))].filter(Boolean).join('\n')
      : `${p.title ? `${p.title}: ` : ''}${pick(labels.empty, ctx.lang)}`,
  speak: (p, ctx) =>
    spokenList(
      p.items.map((t) => t.title),
      labels,
      ctx,
    ),
});

export const TodoItemView = defineView({
  name: 'todo.item',
  description: 'One to-do, with its due date and a tick box.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ id: z.string(), item: Todo }),
  source: { entity: TodoSpec, into: 'item', by: 'id' },
  actions: { toggle },
  labels: { noun: labels.noun },
  text: (p, ctx) => line(p.item, ctx),
  speak: (p, ctx) => `${p.item.title}${p.item.done ? `, ${pick(DONE, ctx.lang)}` : ''}.`,
});
