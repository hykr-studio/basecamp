import { MeetingSpec, MeetingView } from '@app/contracts';
import { clockText, dayText, type Labels, pick, spokenDay, spokenWhen, whenText } from '@app/i18n';
import { z } from 'zod';
import {
  action,
  defineView,
  spokenList,
  type TextContext,
  type ViewLabels,
} from '../define-view.js';

const open = action<MeetingView>({ screen: 'meeting.detail', params: (m) => ({ id: m.id }) });
const STATUS: Record<MeetingView['status'], Labels> = {
  scheduled: { en: 'scheduled', hi: 'तय', te: 'షెడ్యూల్ అయింది' },
  held: { en: 'held, not closed yet', hi: 'हो चुकी, अभी बंद नहीं', te: 'జరిగింది, ఇంకా ముగించలేదు' },
  closed: { en: 'closed', hi: 'बंद', te: 'ముగిసింది' },
};
const WORDS = {
  with: { en: 'With', hi: 'साथ में', te: 'పాల్గొనేవారు' },
  status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
  weekOf: { en: 'Week of', hi: 'हफ़्ता', te: 'వారం' },
} satisfies Record<string, Labels>;
const line = (m: MeetingView, ctx: TextContext) =>
  `• ${m.title}, ${whenText(m.startsAt, ctx.timeZone, ctx.lang)}${m.status === 'scheduled' ? '' : ` (${pick(STATUS[m.status], ctx.lang)})`}`;

const noun = {
  en: ['meeting', 'meetings'],
  hi: ['मीटिंग', 'मीटिंग'],
  te: ['మీటింగ్', 'మీటింగ్‌లు'],
} as const;
const labels = {
  title: { en: 'Meetings', hi: 'मीटिंग', te: 'మీటింగ్‌లు' },
  empty: { en: 'No meetings.', hi: 'कोई मीटिंग नहीं।', te: 'మీటింగ్‌లు ఏవీ లేవు.' },
  noun,
} satisfies ViewLabels;
const week = {
  title: { en: 'This week', hi: 'इस हफ़्ते', te: 'ఈ వారం' },
  empty: {
    en: 'No meetings this week.',
    hi: 'इस हफ़्ते कोई मीटिंग नहीं।',
    te: 'ఈ వారం మీటింగ్‌లు ఏవీ లేవు.',
  },
  noun,
} satisfies ViewLabels;
/** "This week, 3 meetings: …" / "Mon 5 Oct, 2 meetings: …"; the empty line alone. */
const lead = (where: string | undefined, said: string, empty: boolean) =>
  where && !empty ? `${where}, ${said}` : said;
const pickOr = (l: Labels, ctx: TextContext) => pick(l, ctx.lang);

export const MeetingCardView = defineView({
  name: 'meeting.card',
  description: 'One meeting: when, who, its status, and a way to open it.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ id: z.string(), item: MeetingView }),
  source: { entity: MeetingSpec, into: 'item', by: 'id' },
  actions: { open },
  labels: { noun },
  text: (p, ctx) =>
    [
      p.item.title,
      `${whenText(p.item.startsAt, ctx.timeZone, ctx.lang)}–${clockText(p.item.endsAt, ctx.timeZone, ctx.lang)}`,
      p.item.attendees.length
        ? `${pick(WORDS.with, ctx.lang)}: ${p.item.attendees.join(', ')}`
        : '',
      `${pick(WORDS.status, ctx.lang)}: ${pick(STATUS[p.item.status], ctx.lang)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  speak: (p, ctx) => `${p.item.title}, ${spokenWhen(p.item.startsAt, ctx.timeZone, ctx.lang)}.`,
});

export const MeetingListView = defineView({
  name: 'meeting.list',
  description:
    'A list of meetings, each opening its detail. Use for meetings needing prep or closing, or a search. For a day or a week laid out by time, use calendar.day or calendar.week.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(MeetingView) }),
  source: { entity: MeetingSpec, into: 'items' },
  actions: { open },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((m) => line(m, ctx))].filter(Boolean).join('\n')
      : pickOr(labels.empty, ctx),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((m) => m.title),
      labels,
      ctx,
    ),
});

const ymd = z.iso.date();

export const CalendarDayView = defineView({
  name: 'calendar.day',
  description:
    "Meetings laid out by time, grouped by day. Query startsAt for the day (gte the day's start, lte its end) and sort by startsAt. A wider range shows one group per day.",
  surfaces: ['canvas', 'text', 'speech'],
  props: z.object({
    title: z.string().max(60).optional(),
    date: ymd.optional(),
    items: z.array(MeetingView),
  }),
  source: { entity: MeetingSpec, into: 'items' },
  actions: { open },
  labels,
  textLimit: 20,
  text: (p, ctx) =>
    [
      p.title ?? (p.date ? dayText(p.date, ctx.lang) : pickOr(labels.title, ctx)),
      ...(p.items.length
        ? p.items.map((m) => `• ${whenText(m.startsAt, ctx.timeZone, ctx.lang)} ${m.title}`)
        : [pickOr(labels.empty, ctx)]),
    ].join('\n'),
  speak: (p, ctx) =>
    lead(
      p.date ? spokenDay(p.date, ctx.lang) : undefined,
      spokenList(
        p.items.map((m) => m.title),
        labels,
        ctx,
      ),
      p.items.length === 0,
    ),
});

export const CalendarWeekView = defineView({
  name: 'calendar.week',
  description:
    'Seven days of meetings in columns, from `start` (a Monday or today). Query startsAt across those seven days and sort by startsAt. Needs a wide block: on a phone it shows as calendar.day lists.',
  surfaces: ['canvas', 'text', 'speech'],
  props: z.object({
    title: z.string().max(60).optional(),
    start: ymd,
    items: z.array(MeetingView),
  }),
  source: { entity: MeetingSpec, into: 'items' },
  actions: { open },
  labels: week,
  textLimit: 40,
  collapseTo: 'calendar.day',
  text: (p, ctx) =>
    [
      p.title ?? `${pick(WORDS.weekOf, ctx.lang)} ${dayText(p.start, ctx.lang)}`,
      ...(p.items.length ? p.items.map((m) => line(m, ctx)) : [pickOr(week.empty, ctx)]),
    ].join('\n'),
  speak: (p, ctx) =>
    lead(
      pickOr(week.title, ctx),
      spokenList(
        p.items.map((m) => m.title),
        week,
        ctx,
      ),
      p.items.length === 0,
    ),
});
