import { Address, CreatedBy, entitySpec, GeoPoint } from '@hykr/contracts';
import { z } from 'zod';
import { NoteView } from '../../notes/contracts/index.js';
import { Todo } from '../../todos/contracts/index.js';

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
  /** Where it is held, as people write it. */
  address: Address.nullable(),
  /** Its point on the map: check-ins are measured from it. */
  location: GeoPoint.nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type MeetingView = z.infer<typeof MeetingView>;

/** How close to a meeting's point a check-in must be, in metres (and how precise the fix). */
export const CHECK_IN_RADIUS_M = 200;

const endsAfterStart = (v: { startsAt?: string; endsAt?: string }) =>
  !v.startsAt || !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt);

const place = {
  address: Address.nullable().optional(),
  location: GeoPoint.nullable().optional(),
};

export const CreateMeetingInput = z
  .object({ title, startsAt: at, endsAt: at, attendees: attendees.default([]), ...place })
  .refine(endsAfterStart, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type CreateMeetingInput = z.input<typeof CreateMeetingInput>;

export const UpdateMeetingInput = z
  .object({
    title: title.optional(),
    startsAt: at.optional(),
    endsAt: at.optional(),
    attendees: attendees.optional(),
    status: MeetingStatus.optional(),
    ...place,
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
  // What people call each field, in every language (approval cards, history, voice).
  fieldLabels: {
    title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' },
    startsAt: { en: 'Starts', hi: 'शुरू', te: 'ప్రారంభం' },
    endsAt: { en: 'Ends', hi: 'खत्म', te: 'ముగింపు' },
    attendees: { en: 'Attendees', hi: 'शामिल लोग', te: 'హాజరయ్యేవారు' },
    status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
    address: { en: 'Address', hi: 'पता', te: 'చిరునామా' },
    location: { en: 'Place', hi: 'जगह', te: 'స్థలం' },
    createdBy: { en: 'Created by', hi: 'किसने बनाया', te: 'ఎవరు సృష్టించారు' },
  },
  list: {
    // location: near a point (location[near]=lat,lng,metres) or in a box; sort=location is
    // nearest first.
    filterable: { status: 'enum', startsAt: 'date', title: 'text', location: 'geo' },
    sortable: ['startsAt', 'createdAt', 'location'],
    defaultSort: [['startsAt', 'desc']],
    search: ['title'],
    pageSize: { default: 25, max: 100 },
    examples: {
      status: '"scheduled"',
      startsAt: '{ "gte": "2026-10-07T00:00:00Z", "lte": "2026-10-07T23:59:59Z" }',
      title: '{ "contains": "site review" }',
      location: '{ "near": { "lat": 12.97, "lng": 77.59, "radiusM": 2000 } }',
    },
  },
  expose: { list: 'all', get: 'all', create: 'all', update: 'all', delete: 'human' },
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'meeting.list', item: 'meeting.card' },
  // Meetings are events in their owner's connected calendar, in feeds and in invites.
  traits: {
    schedulable: { title: 'title', startsAt: 'startsAt', endsAt: 'endsAt', location: 'address' },
  },
});

/** A check-in at a meeting: where the person was, how far from the meeting, how precise. */
export const MeetingCheckInView = z.object({
  id: z.string(),
  meetingId: z.string(),
  location: GeoPoint,
  distanceM: z.number(),
  accuracyM: z.number().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type MeetingCheckInView = z.infer<typeof MeetingCheckInView>;

export const MeetingCheckInSpec = entitySpec({
  name: 'meetingCheckIn',
  label: 'check-in',
  description: 'Check-ins at meetings: where the person was and how far from the meeting.',
  schemas: {
    read: MeetingCheckInView,
    create: z.object({
      meetingId: z.string(),
      location: GeoPoint,
      distanceM: z.number().min(0),
      accuracyM: z.number().min(0).nullable().optional(),
    }),
    update: z.object({ accuracyM: z.number().min(0).nullable().optional() }),
  },
  fieldLabels: {
    location: { en: 'Where', hi: 'कहाँ', te: 'ఎక్కడ' },
    distanceM: { en: 'Distance (m)', hi: 'दूरी (मी)', te: 'దూరం (మీ)' },
  },
  list: {
    filterable: { meetingId: 'id' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'desc']],
    pageSize: { default: 25, max: 100 },
  },
  // People check in where they are, through meeting.check-in; the assistant has no position.
  expose: {
    list: 'human',
    get: 'human',
    create: 'internal',
    update: 'internal',
    delete: 'internal',
  },
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

export const CheckInInput = z.object({
  meetingId: z.uuid(),
  /** Where the device says the person is. */
  at: GeoPoint,
  /** How far off the device says its fix may be, in metres. */
  accuracyM: z.number().min(0).max(100_000).optional(),
});
export type CheckInInput = z.infer<typeof CheckInInput>;
export type RescheduleMeetingResult = z.infer<typeof RescheduleMeetingResult>;
