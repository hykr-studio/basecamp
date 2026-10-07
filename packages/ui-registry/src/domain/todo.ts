import { Todo, TodoSpec } from '@app/contracts';
import { z } from 'zod';
import { action, defineView } from '../define-view.js';
import { count, dayText, firstFew } from '../format.js';

const line = (t: Todo) =>
  `${t.done ? '✓' : '•'} ${t.title}${t.dueOn ? ` (due ${dayText(t.dueOn)})` : ''}`;
const toggle = action<Todo>({
  command: 'todo.update',
  args: (t) => ({ id: t.id, done: !t.done }),
});

export const TodoListView = defineView({
  name: 'todo.list',
  description:
    'A checklist of to-dos the person can tick. Use for any list of tasks, including "what is due". Not for a single to-do (todo.item).',
  surfaces: ['inline', 'canvas', 'text', 'voice'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Todo) }),
  source: { entity: TodoSpec, into: 'items' },
  actions: { toggle },
  text: (p) =>
    p.items.length
      ? [p.title, ...p.items.map(line)].filter(Boolean).join('\n')
      : `${p.title ? `${p.title}: ` : ''}no to-dos.`,
  speak: (p) =>
    p.items.length
      ? `${count(p.items.length, 'to-do')}: ${firstFew(p.items.map((t) => t.title))}.`
      : 'No to-dos.',
});

export const TodoItemView = defineView({
  name: 'todo.item',
  description: 'One to-do, with its due date and a tick box.',
  surfaces: ['inline', 'canvas', 'text', 'voice'],
  props: z.object({ id: z.string(), item: Todo }),
  source: { entity: TodoSpec, into: 'item', by: 'id' },
  actions: { toggle },
  text: (p) => line(p.item),
  speak: (p) => `${p.item.title}${p.item.done ? ', done' : ''}.`,
});
