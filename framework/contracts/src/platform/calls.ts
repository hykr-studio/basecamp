import { z } from 'zod';
import { commandSpec } from '../framework/spec.js';
import { defineCapability } from '../roles.js';

/**
 * Phone calls, as `/api/calls` shows them: a log of calls, usually about a record, written by
 * hand, by the assistant, or by the business's telephony provider; and click-to-call through
 * that provider. The framework ships no provider: an application adds one (`TelephonyProvider`).
 */

/** E.164: '+' and 8 to 15 digits. */
export const PhoneNumber = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'a phone number in international form, like +14155550123');

export const CallDirection = z.enum(['inbound', 'outbound']);
export type CallDirection = z.infer<typeof CallDirection>;

/** Asked of the provider, ringing, talking, then completed, missed, failed or cancelled. */
export const CallStatus = z.enum([
  'requested',
  'ringing',
  'in_progress',
  'completed',
  'missed',
  'failed',
  'cancelled',
]);
export type CallStatus = z.infer<typeof CallStatus>;

/** The statuses a call never leaves. */
export const FINISHED_CALL_STATUSES: readonly CallStatus[] = [
  'completed',
  'missed',
  'failed',
  'cancelled',
];

/** The record a call is about. */
export const CallAbout = z.object({ entity: z.string(), id: z.string() });

export const CallInfo = z.object({
  id: z.string(),
  direction: CallDirection,
  status: CallStatus,
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** The member on the call. */
  userId: z.string().nullable(),
  about: CallAbout.nullable(),
  /** The telephony provider that connected it, if any. */
  provider: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  durationS: z.number().int().nullable(),
  notes: z.string().nullable(),
  error: z.string().nullable(),
  /** Who wrote it: a person, the assistant, or the provider. */
  createdBy: z.enum(['person', 'assistant', 'system']),
  createdAt: z.iso.datetime(),
});
export type CallInfo = z.infer<typeof CallInfo>;

const about = {
  entity: z.string().min(1).max(100).optional().describe("The record's kind it is about"),
  id: z.string().min(1).max(100).optional().describe("The record's id"),
};
const at = z.iso.datetime({ offset: true });
const notes = z.string().trim().max(4000);

export const LogCallInput = z.object({
  direction: CallDirection.describe('inbound: they called; outbound: we called'),
  status: CallStatus.default('completed').describe('How it went'),
  from: PhoneNumber.optional(),
  to: PhoneNumber.optional(),
  ...about,
  startedAt: at.optional().describe('When it started (ISO date-time)'),
  endedAt: at.optional(),
  durationS: z.number().int().min(0).max(86_400).optional().describe('How long, in seconds'),
  notes: notes.optional().describe('What was said or agreed'),
});
export type LogCallInput = z.input<typeof LogCallInput>;

/** Write down a call that happened (or was missed), usually on the record it was about. */
export const LogCallSpec = commandSpec({
  name: 'call.log',
  description:
    'Log a phone call on a record: who called whom, how it went, how long, and notes. Give the record (entity and id) the call was about.',
  input: LogCallInput,
  output: CallInfo,
  http: { method: 'POST', path: '/api/calls' },
  tool: 'log-call',
  expose: 'all',
  verb: { do: 'log', did: 'logged' },
  touches: [],
});

export const DialCallInput = z.object({
  to: PhoneNumber.describe('Whom to call'),
  from: PhoneNumber.optional().describe('Your own number, if the provider rings you first'),
  ...about,
});
export type DialCallInput = z.input<typeof DialCallInput>;

/** Click-to-call: the business's telephony provider connects you with the number. */
export const DialCallSpec = commandSpec({
  name: 'call.dial',
  description:
    "Call a phone number through the business's telephony provider: it rings the user and connects the call, and the call is logged on the record. Use it only when the user asks to call someone.",
  input: DialCallInput,
  output: CallInfo,
  http: { method: 'POST', path: '/api/calls/dial' },
  tool: 'dial-call',
  expose: 'all',
  approvalNote: 'When you call it, the call waits for the user to approve it.',
  verb: { do: 'call', did: 'called' },
  touches: [],
});

export const UpdateCallInput = z.object({
  callId: z.uuid(),
  status: CallStatus.optional(),
  endedAt: at.optional(),
  durationS: z.number().int().min(0).max(86_400).optional(),
  notes: notes.nullable().optional(),
});

/** Change a logged call: its notes, how it went, when it ended. */
export const UpdateCallSpec = commandSpec({
  name: 'call.update',
  description: "Change a logged call's notes, status, end or duration.",
  input: UpdateCallInput,
  output: CallInfo,
  http: { method: 'PATCH', path: '/api/calls/:callId' },
  expose: 'human',
  verb: { do: 'change', did: 'changed' },
  touches: [],
});

export const CallsCapabilities = {
  /** Read every call of the business that is about no record. */
  readAll: defineCapability({
    name: 'calls.read_all',
    label: {
      en: "See all the business's calls",
      hi: 'व्यवसाय की सभी कॉल देखें',
      te: 'వ్యాపారం యొక్క అన్ని కాల్‌లు చూడండి',
    },
    roles: ['owner', 'admin'],
  }),
};
