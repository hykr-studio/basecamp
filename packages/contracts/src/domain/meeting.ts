import { z } from 'zod';
import { CreatedBy, entitySpec } from '../framework/spec.js';
import { NoteView } from './note.js';
import { Todo } from './todo.js';

const title = z.string().min(1).max(200);
const at = z.iso.datetime({ offset: true });
const attendees = z.array(z.string().min(1).max(100)).max(50);

export const MeetingStatus = z.enum(['scheduled', 'held', 'closed']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

export const MeetingView = z.object({
  id: z.string(),
  title,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  attendees,
  status: MeetingStatus,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type MeetingView = z.infer<typeof MeetingView>;

const endsAfterStart = (v: { startsAt?: string; endsAt?: string }) =>
  !v.startsAt || !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt);

export const CreateMeetingInput = z
  .object({ title, startsAt: at, endsAt: at, attendees: attendees.default([]) })
  .refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type CreateMeetingInput = z.input<typeof CreateMeetingInput>;

export const UpdateMeetingInput = z
  .object({
    title: title.optional(),
    startsAt: at.optional(),
    endsAt: at.optional(),
    attendees: attendees.optional(),
    status: MeetingStatus.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Send at least one field to change')
  .refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type UpdateMeetingInput = z.infer<typeof UpdateMeetingInput>;

export const MeetingSpec = entitySpec({
  name: 'meeting',
  label: 'meeting',
  description:
    'Meetings: title, start and end (ISO date-times), attendees, and a status (scheduled → held → closed). Close one with close-meeting, move one with reschedule-meeting.',
  schemas: { read: MeetingView, create: CreateMeetingInput, update: UpdateMeetingInput },
  list: {
    filterable: { status: 'enum', startsAt: 'date', title: 'text' },
    sortable: ['startsAt', 'createdAt'],
    defaultSort: [['startsAt', 'desc']],
    search: ['title'],
    pageSize: { default: 25, max: 100 },
    examples: {
      status: '"scheduled"',
      startsAt: '{ "gte": "2026-10-07T00:00:00Z", "lte": "2026-10-07T23:59:59Z" }',
      title: '{ "contains": "site review" }',
    },
  },
  expose: { list: 'all', get: 'all', create: 'all', update: 'all', delete: 'human' },
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'meeting.list', item: 'meeting.card' },
});

/* ── Commands ─────────────────────────────────────────────────────────────── */

export const ActionItem = z.object({
  title: z.string().min(1).max(200),
  dueOn: z.iso.date().optional(),
});

export const CloseMeetingInput = z.object({
  meetingId: z.uuid(),
  summary: z.string().min(1).max(2000),
  decisions: z.array(z.string().min(1).max(500)).max(50).default([]),
  actionItems: z.array(ActionItem).max(50).default([]),
});
export type CloseMeetingInput = z.input<typeof CloseMeetingInput>;

export const CloseMeetingResult = z.object({
  meeting: MeetingView,
  note: NoteView,
  todos: z.array(Todo),
});
export type CloseMeetingResult = z.infer<typeof CloseMeetingResult>;

export const RescheduleMeetingInput = z
  .object({ meetingId: z.uuid(), startsAt: at, endsAt: at })
  .refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type RescheduleMeetingInput = z.infer<typeof RescheduleMeetingInput>;

export const RescheduleMeetingResult = z.object({ meeting: MeetingView, shifted: z.array(Todo) });
export type RescheduleMeetingResult = z.infer<typeof RescheduleMeetingResult>;
