import {
  CreatedBy,
  CustomFieldsInput,
  CustomFieldValues,
  commandSpec,
  defineFeatureFlag,
  entitySpec,
} from '@hykr/contracts';
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
  /** The business's own fields (a priority, say), defined in its settings. */
  custom: CustomFieldValues,
  /** How many times it was written: a change made offline is sent with the one it saw. */
  version: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodoInput = z.object({
  title,
  dueOn: dueOn.optional(),
  meetingId: z.uuid().optional(),
  cost: cost.optional(),
  custom: CustomFieldsInput.optional(),
});
export type CreateTodoInput = z.infer<typeof CreateTodoInput>;

export const UpdateTodoInput = z
  .object({
    title: title.optional(),
    done: z.boolean().optional(),
    dueOn: dueOn.nullable().optional(),
    meetingId: z.uuid().nullable().optional(),
    cost: cost.nullable().optional(),
    custom: CustomFieldsInput.optional(),
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
    custom: { en: 'More', hi: 'और', te: 'మరిన్ని' },
    createdBy: { en: 'Created by', hi: 'किसने बनाया', te: 'ఎవరు సృష్టించారు' },
  },
  list: {
    filterable: {
      done: 'boolean',
      dueOn: 'date',
      meetingId: 'id',
      title: 'text',
      cost: 'number',
      custom: 'custom',
    },
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
      custom: '{ "priority": "high" }',
    },
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'todo.list', item: 'todo.item' },
  traits: {
    // Each business adds its own fields to to-dos (Settings → Custom fields: a priority, say).
    customFields: {},
    // Its meeting is one the writer can read in their business (named, not imported: meetings
    // builds on to-dos).
    references: { meetingId: 'meeting' },
    // The cost is for people who buy, and the business's owners and admins (roles.ts).
    fieldPolicy: { cost: 'todos.cost.read' },
    // Added, ticked, renamed or deleted on a phone without a network: kept on the phone and
    // synced when it is back (a new to-do's id is chosen there).
    offline: {},
    // A version per change: a to-do ticked on two phones offline syncs once; the second is a
    // conflict its person resolves, never a silent overwrite.
    versioned: {},
  },
});

/** Clear the person's done to-dos in one go: behind a flag the business switches itself. */
export const ClearDoneTodosSpec = commandSpec({
  name: 'todo.clearDone',
  description:
    "Delete every to-do of the user's that is done, in one step. Only when they ask to clear done to-dos.",
  input: z.object({}),
  output: z.object({ cleared: z.number().int() }),
  http: { method: 'POST', path: '/api/todos/clear-done' },
  tool: 'clear-done-todos',
  expose: 'all',
  approvalNote: 'When the assistant calls it, it waits for the user to approve it.',
  verb: { do: 'clear done to-dos', did: 'cleared the done to-dos' },
  touches: ['todo'],
  // It deletes: an outside AI client is told so (MCP's destructive hint).
  traits: { destructive: true },
});

/** The business switches "clear done to-dos" on in its settings; off until it does. */
export const ClearDoneFlag = defineFeatureFlag({
  key: 'todos.clear-done',
  label: { en: 'Clear done to-dos', hi: 'पूरे हुए काम हटाएं', te: 'పూర్తయిన పనులను తొలగించండి' },
  description: {
    en: 'A button and an assistant command that delete every done to-do at once.',
    hi: 'एक बटन और सहायक का आदेश जो सभी पूरे हुए काम एक साथ हटाता है।',
    te: 'పూర్తయిన అన్ని పనులను ఒకేసారి తొలగించే బటన్ మరియు సహాయక ఆదేశం.',
  },
  managedBy: 'tenant',
  gates: { commands: ['todo.clearDone'] },
});
