import { MeetingSpec, MeetingView } from '@app/contracts';
import { z } from 'zod';
import { action, defineView, type TextContext } from '../define-view.js';
import { clockText, count, dayText, firstFew, whenText } from '../format.js';

const open = action<MeetingView>({ screen: 'meeting.detail', params: (m) => ({ id: m.id }) });
const STATUS = { scheduled: 'scheduled', held: 'held, not closed yet', closed: 'closed' } as const;
const line = (m: MeetingView, ctx: TextContext) =>
  `• ${m.title}, ${whenText(m.startsAt, ctx.timeZone)}${m.status === 'scheduled' ? '' : ` (${STATUS[m.status]})`}`;

export const MeetingCardView = defineView({
  name: 'meeting.card',
  description: 'One meeting: when, who, its status, and a way to open it.',
  surfaces: ['inline', 'canvas', 'text', 'voice'],
  props: z.object({ id: z.string(), item: MeetingView }),
  source: { entity: MeetingSpec, into: 'item', by: 'id' },
  actions: { open },
  text: (p, ctx) =>
    [
      p.item.title,
      `${whenText(p.item.startsAt, ctx.timeZone)}–${clockText(p.item.endsAt, ctx.timeZone)}`,
      p.item.attendees.length ? `With ${p.item.attendees.join(', ')}` : '',
      `Status: ${STATUS[p.item.status]}`,
    ]
      .filter(Boolean)
      .join('\n'),
  speak: (p, ctx) => `${p.item.title}, ${whenText(p.item.startsAt, ctx.timeZone)}.`,
});

export const MeetingListView = defineView({
  name: 'meeting.list',
  description:
    'A list of meetings, each opening its detail. Use for meetings needing prep or closing, or a search. For a day or a week laid out by time, use calendar.day or calendar.week.',
  surfaces: ['inline', 'canvas', 'text', 'voice'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(MeetingView) }),
  source: { entity: MeetingSpec, into: 'items' },
  actions: { open },
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((m) => line(m, ctx))].filter(Boolean).join('\n')
      : 'No meetings.',
  speak: (p) =>
    p.items.length
      ? `${count(p.items.length, 'meeting')}: ${firstFew(p.items.map((m) => m.title))}.`
      : 'No meetings.',
});

const ymd = z.iso.date();

export const CalendarDayView = defineView({
  name: 'calendar.day',
  description:
    "Meetings laid out by time, grouped by day. Query startsAt for the day (gte the day's start, lte its end) and sort by startsAt. A wider range shows one group per day.",
  surfaces: ['canvas', 'text', 'voice'],
  props: z.object({
    title: z.string().max(60).optional(),
    date: ymd.optional(),
    items: z.array(MeetingView),
  }),
  source: { entity: MeetingSpec, into: 'items' },
  actions: { open },
  textLimit: 20,
  text: (p, ctx) =>
    [
      p.title ?? (p.date ? dayText(p.date) : 'Meetings'),
      ...(p.items.length
        ? p.items.map((m) => `• ${whenText(m.startsAt, ctx.timeZone)} ${m.title}`)
        : ['No meetings.']),
    ].join('\n'),
  speak: (p) =>
    p.items.length
      ? `${count(p.items.length, 'meeting')}${p.date ? ` on ${dayText(p.date)}` : ''}: ${firstFew(p.items.map((m) => m.title))}.`
      : 'No meetings.',
});

export const CalendarWeekView = defineView({
  name: 'calendar.week',
  description:
    'Seven days of meetings in columns, from `start` (a Monday or today). Query startsAt across those seven days and sort by startsAt. Needs a wide block: on a phone it shows as calendar.day lists.',
  surfaces: ['canvas', 'text', 'voice'],
  props: z.object({
    title: z.string().max(60).optional(),
    start: ymd,
    items: z.array(MeetingView),
  }),
  source: { entity: MeetingSpec, into: 'items' },
  actions: { open },
  textLimit: 40,
  collapseTo: 'calendar.day',
  text: (p, ctx) =>
    [
      p.title ?? `Week of ${dayText(p.start)}`,
      ...(p.items.length ? p.items.map((m) => line(m, ctx)) : ['No meetings this week.']),
    ].join('\n'),
  speak: (p) =>
    p.items.length
      ? `${count(p.items.length, 'meeting')} this week: ${firstFew(p.items.map((m) => m.title))}.`
      : 'No meetings this week.',
});
