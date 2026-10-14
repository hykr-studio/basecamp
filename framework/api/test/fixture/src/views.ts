import { pick } from '@hykr/i18n';
import { defineView, spokenList, type ViewLabels } from '@hykr/ui-registry';
import { z } from 'zod';
import { Task, TaskSpec } from './contracts.js';

const labels = {
  title: { en: 'Tasks', hi: 'काम', te: 'పనులు' },
  empty: { en: 'No tasks.', hi: 'कोई काम नहीं।', te: 'పనులు ఏవీ లేవు.' },
  noun: { en: ['task', 'tasks'], hi: ['काम', 'काम'], te: ['పని', 'పనులు'] },
} satisfies ViewLabels;

export const TaskListView = defineView({
  name: 'task.list',
  description: 'A list of tasks.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Task) }),
  source: { entity: TaskSpec, into: 'items' },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? p.items.map((t) => `${t.done ? '✓' : '•'} ${t.title}`).join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((t) => t.title),
      labels,
      ctx,
    ),
});

export const fixtureViews = { views: [TaskListView], screens: [] };
