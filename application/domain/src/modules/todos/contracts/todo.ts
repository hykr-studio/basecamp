import { CreatedBy, entitySpec } from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);
const dueOn = z.iso.date();
/** What it costs, in minor units of the business's currency. */
const cost = z.number().int().min(0);

export const Todo = z.object({
  id: z.string(),
  title,
  done: z.boolean(),
  dueOn: dueOn.nullable(),
  meetingId: z.string().nullable(),
  /** Only for people with `todos.cost.read`: absent for everyone else. */
  cost: cost.nullable().optional(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodoInput = z.object({
  title,
  dueOn: dueOn.optional(),
  meetingId: z.uuid().optional(),
  cost: cost.optional(),
});
export type CreateTodoInput = z.infer<typeof CreateTodoInput>;

export const UpdateTodoInput = z
  .object({
    title: title.optional(),
    done: z.boolean().optional(),
    dueOn: dueOn.nullable().optional(),
    meetingId: z.uuid().nullable().optional(),
    cost: cost.nullable().optional(),
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
  // What people call each field, in every language (approval cards, history, voice).
  fieldLabels: {
    title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' },
    done: { en: 'Done', hi: 'पूरा', te: 'పూర్తి' },
    dueOn: { en: 'Due', hi: 'आखिरी तारीख', te: 'గడువు' },
    meetingId: { en: 'Meeting', hi: 'मीटिंग', te: 'మీటింగ్' },
    cost: { en: 'Cost', hi: 'लागत', te: 'ఖర్చు' },
    createdBy: { en: 'Created by', hi: 'किसने बनाया', te: 'ఎవరు సృష్టించారు' },
  },
  list: {
    filterable: { done: 'boolean', dueOn: 'date', meetingId: 'id', title: 'text', cost: 'number' },
    sortable: ['dueOn', 'createdAt', 'title'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
    examples: {
      done: 'false',
      dueOn: '{ "lte": "2026-10-31" }',
      meetingId: '"<meeting id>"',
      title: '{ "contains": "tiles" }',
      cost: '{ "gt": 50000 }',
    },
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'todo.list', item: 'todo.item' },
  // The cost is for people who buy, and the business's owners and admins (roles.ts).
  traits: { fieldPolicy: { cost: 'todos.cost.read' } },
});
