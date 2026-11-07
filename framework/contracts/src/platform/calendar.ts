import { z } from 'zod';
import { commandSpec } from '../framework/spec.js';
import { defineCapability } from '../roles.js';
import { Lang } from '../voice.js';

/**
 * Calendars, as `/api/calendar/*` shows them: a person's connections to their own calendars
 * (Google), where schedulable records appear and follow every change; invites to a record by
 * email (iCalendar); private feeds a calendar app subscribes to; and busy and free time.
 */

/** The calendar services a person can connect. */
export const CalendarProvider = z.enum(['google']);
export type CalendarProvider = z.infer<typeof CalendarProvider>;

/** Working, waiting for the person to connect again (Google refused the grant), or stopped. */
export const CalendarConnectionStatus = z.enum(['active', 'needs_reauth', 'stopped']);
export type CalendarConnectionStatus = z.infer<typeof CalendarConnectionStatus>;

export const CalendarConnectionInfo = z.object({
  id: z.string(),
  provider: CalendarProvider,
  /** The account connected: its email. */
  account: z.string(),
  status: CalendarConnectionStatus,
  /** Google tells us about changes (a push channel is open); else they are looked for every few minutes. */
  push: z.boolean(),
  lastSyncedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type CalendarConnectionInfo = z.infer<typeof CalendarConnectionInfo>;

/** Whether this server offers a provider (its client id and secret are set). */
export const CalendarProviderInfo = z.object({
  name: CalendarProvider,
  available: z.boolean(),
});
export type CalendarProviderInfo = z.infer<typeof CalendarProviderInfo>;

export const ConnectCalendarInput = z.object({ provider: CalendarProvider });

/** A private feed: its URL is shown once, when it is made. */
export const CalendarFeedInfo = z.object({
  id: z.string(),
  label: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type CalendarFeedInfo = z.infer<typeof CalendarFeedInfo>;

export const CreateFeedInput = z.object({ label: z.string().trim().min(1).max(100).optional() });

/** A busy interval or a free slot. */
export const TimeInterval = z.object({ start: z.iso.datetime(), end: z.iso.datetime() });
export type TimeInterval = z.infer<typeof TimeInterval>;

export const BusyTimes = z.object({
  /** The person has a connected calendar that answered. */
  connected: z.boolean(),
  busy: z.array(TimeInterval),
});
export type BusyTimes = z.infer<typeof BusyTimes>;

export const FreeTimes = z.object({
  connected: z.boolean(),
  slots: z.array(TimeInterval),
  /** The zone `hours` were read in: the business's. */
  timeZone: z.string(),
});
export type FreeTimes = z.infer<typeof FreeTimes>;

const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 09:00');

/** GET /api/calendar/free: slots of `minutes` between `from` and `to` (at most 31 days). */
export const FreeTimeQuery = z.object({
  from: z.iso.datetime({ offset: true }).describe('Look from (ISO date-time)'),
  to: z.iso.datetime({ offset: true }).describe('Look until (ISO date-time), at most 31 days on'),
  minutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .describe('How long each slot is'),
  step: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional()
    .describe('Minutes between starts'),
  hoursFrom: LocalTime.optional().describe(
    "Earliest local start, like 09:00 (the business's zone)",
  ),
  hoursTo: LocalTime.optional().describe('Latest local end, like 18:00'),
  userId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Another member's free time (with the capability)"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type FreeTimeQuery = z.input<typeof FreeTimeQuery>;

/* ── Invites ─────────────────────────────────────────────────────────────── */

/** Whom an invite goes to: an email address, or a member of the business. */
export const InviteRecipient = z.union([
  z
    .object({
      email: z.email().max(254).describe('An email address'),
      name: z.string().trim().min(1).max(100).optional().describe('Their name'),
    })
    .strict(),
  z.object({ userId: z.string().min(1).describe("A member's id") }).strict(),
]);
export type InviteRecipient = z.infer<typeof InviteRecipient>;

/** queued, sending, sent (the latest version went), or failed. */
export const InviteStatus = z.enum(['queued', 'sending', 'sent', 'failed']);

export const InviteInfo = z.object({
  id: z.string(),
  record: z.object({ entity: z.string(), id: z.string() }),
  email: z.string(),
  name: z.string().nullable(),
  /** 0 first; one more for each update sent after it. */
  sequence: z.number().int(),
  /** REQUEST (an invite or an update) or CANCEL. */
  method: z.enum(['REQUEST', 'CANCEL']),
  status: InviteStatus,
  error: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type InviteInfo = z.infer<typeof InviteInfo>;

export const SendInviteInput = z.object({
  entity: z.string().min(1).max(100).describe("The record's kind (an entity name)"),
  id: z.string().min(1).max(100).describe("The record's id"),
  to: z.array(InviteRecipient).min(1).max(20).describe('Whom to invite'),
  lang: Lang.optional().describe('The email in en, hi or te. Default: en'),
});
export type SendInviteInput = z.input<typeof SendInviteInput>;

/** Email a calendar invite (an .ics) for a record with a time; updates follow it. */
export const SendInviteSpec = commandSpec({
  name: 'calendar.invite',
  description:
    'Email people a calendar invite for a record that has a time: an .ics file their calendar adds. When the record changes later they get an update, and a cancellation if it is deleted. Use it only when the user asks to invite someone.',
  input: SendInviteInput,
  output: z.object({ invites: z.array(InviteInfo) }),
  http: { method: 'POST', path: '/api/calendar/invites' },
  tool: 'send-calendar-invite',
  expose: 'all',
  approvalNote: 'When you invite anyone but the user, the invite waits for the user to approve it.',
  verb: { do: 'invite', did: 'invited' },
  touches: [],
});

/* ── Capabilities ─────────────────────────────────────────────────────────── */

export const CalendarCapabilities = {
  /** Read other members' busy and free time (never their events' details). */
  availability: defineCapability({
    name: 'calendar.availability.read',
    label: {
      en: "See other people's free time",
      hi: 'दूसरों का खाली समय देखें',
      te: 'ఇతరుల ఖాళీ సమయం చూడండి',
    },
    roles: ['owner', 'admin', 'ops'],
  }),
};

/* ── Stored events ────────────────────────────────────────────────────────── */

/**
 * `calendar.event_moved` and `calendar.event_removed`: a person changed one of our events in
 * their own calendar. The framework writes nothing back; an application may (resourceType
 * `calendarEvent`).
 */
export const CalendarEventChange = z.object({
  /** The link between the record and the calendar event. */
  id: z.string(),
  tenantId: z.string(),
  entity: z.string(),
  recordId: z.string(),
  /** The person whose calendar it is. */
  userId: z.string(),
  provider: CalendarProvider,
  /** Where it is now (moved only). */
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
  /** What was sent last. */
  sentStartsAt: z.iso.datetime().nullable(),
  sentEndsAt: z.iso.datetime().nullable(),
});
export type CalendarEventChange = z.infer<typeof CalendarEventChange>;
