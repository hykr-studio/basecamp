// The fixture's entities and command: a task (plain CRUD) and a visit (a time, a reminder, and
// a command that moves it). Small, but it covers what the framework's e2e tests need from a
// domain, so they pass without any application.
import { CreatedBy, commandSpec, defineDomain, entitySpec } from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);
const at = z.iso.datetime({ offset: true });

export const Task = z.object({
  id: z.string(),
  title,
  done: z.boolean(),
  dueOn: z.iso.date().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type Task = z.infer<typeof Task>;

export const TaskSpec = entitySpec({
  name: 'task',
  label: 'task',
  description: 'Tasks: a title, done or not, and an optional due date.',
  schemas: {
    read: Task,
    create: z.object({ title, dueOn: z.iso.date().optional() }),
    update: z.object({
      title: title.optional(),
      done: z.boolean().optional(),
      dueOn: z.iso.date().nullable().optional(),
    }),
  },
  fieldLabels: { title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' } },
  list: {
    filterable: { done: 'boolean', dueOn: 'date', title: 'text' },
    sortable: ['dueOn', 'createdAt', 'title'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'task.list' },
});

export const Visit = z.object({
  id: z.string(),
  title,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type Visit = z.infer<typeof Visit>;

export const VisitSpec = entitySpec({
  name: 'visit',
  label: 'visit',
  description: 'Visits: a title, a start and an end (ISO date-times).',
  schemas: {
    read: Visit,
    create: z.object({ title, startsAt: at, endsAt: at }),
    update: z.object({ title: title.optional(), startsAt: at.optional(), endsAt: at.optional() }),
  },
  list: {
    filterable: { startsAt: 'date', title: 'text' },
    sortable: ['startsAt', 'createdAt'],
    defaultSort: [['startsAt', 'desc']],
    search: ['title'],
    pageSize: { default: 25, max: 100 },
  },
  // People delete visits; the assistant may not.
  expose: { list: 'all', get: 'all', create: 'all', update: 'all', delete: 'human' },
  approval: { delete: (p) => p.actor.kind === 'agent' },
});

export const RescheduleVisitSpec = commandSpec({
  name: 'visit.reschedule',
  description: 'Move a visit to a new start and end.',
  input: z.object({ visitId: z.uuid(), startsAt: at, endsAt: at }),
  output: Visit,
  http: { method: 'POST', path: '/api/visits/:visitId/reschedule' },
  tool: 'reschedule-visit',
  expose: 'all',
  verb: { do: 'move', did: 'moved' },
  touches: ['visit'],
});

export const fixtureDomain = defineDomain({
  name: 'Fixture',
  entities: { tasks: TaskSpec, visits: VisitSpec },
  commands: [RescheduleVisitSpec],
});
