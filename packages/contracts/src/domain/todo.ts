import { z } from 'zod';
import { CreatedBy, entitySpec } from '../framework/spec.js';

const title = z.string().min(1).max(200);
const dueOn = z.iso.date();

export const Todo = z.object({
  id: z.string(),
  title,
  done: z.boolean(),
  dueOn: dueOn.nullable(),
  meetingId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodoInput = z.object({
  title,
  dueOn: dueOn.optional(),
  meetingId: z.uuid().optional(),
});
export type CreateTodoInput = z.infer<typeof CreateTodoInput>;

export const UpdateTodoInput = z
  .object({
    title: title.optional(),
    done: z.boolean().optional(),
    dueOn: dueOn.nullable().optional(),
    meetingId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'Send at least one field to change',
  );
export type UpdateTodoInput = z.infer<typeof UpdateTodoInput>;

export const TodoSpec = entitySpec({
  name: 'todo',
  label: 'to-do',
  description:
    "The user's to-dos: short tasks with an optional due date, optionally linked to a meeting.",
  schemas: { read: Todo, create: CreateTodoInput, update: UpdateTodoInput },
  list: {
    filterable: { done: 'boolean', dueOn: 'date', meetingId: 'id', title: 'text' },
    sortable: ['dueOn', 'createdAt', 'title'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
    examples: {
      done: 'false',
      dueOn: '{ "lte": "2026-10-31" }',
      meetingId: '"<meeting id>"',
      title: '{ "contains": "tiles" }',
    },
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'todo.list', item: 'todo.item' },
});
