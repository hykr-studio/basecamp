// iCalendar (RFC 5545) text: one or more events, as an invite (METHOD:REQUEST or CANCEL, RFC
// 5546) or a feed (no method). Times are written in UTC, so no VTIMEZONE is needed. Text is
// escaped and long lines are folded at 75 octets, as calendar apps expect.

/** A person on an event: an email address, and a name to show. */
export interface IcsPerson {
  email: string;
  name?: string;
}

/** One event. */
export interface IcsEvent {
  /** Stable across updates and cancellations: '<entity>-<id>@<host>'. */
  uid: string;
  /** 0 first, one more for every change sent after it. */
  sequence?: number;
  /** When this text was made. Default: now. */
  stamp?: Date | string;
  start: Date | string;
  end: Date | string;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  /** Default CONFIRMED; CANCELLED in a cancellation. */
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  organizer?: IcsPerson;
  attendees?: readonly IcsPerson[];
  /** Ask attendees to reply (RSVP=TRUE). Default false: replies are not read. */
  rsvp?: boolean;
}

export interface IcsCalendar {
  /** 'REQUEST' for an invite or update, 'CANCEL' to withdraw it; none for a feed. */
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  /** '-//<maker>//<product>//EN'. */
  prodId: string;
  /** What a calendar app calls a subscribed feed (X-WR-CALNAME). */
  name?: string;
  events: readonly IcsEvent[];
}

/** A date-time in UTC, the basic form: 20261107T093000Z. */
export function icsDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${String(value)}`);
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** TEXT values: backslash, semicolon and comma escaped, line breaks as \n, no control bytes. */
export function icsText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // Control characters other than the line break have no place in a calendar.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n')
  );
}

/** A parameter value (a name in CN=): DQUOTE-wrapped, with no DQUOTE or control bytes inside. */
function paramValue(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const clean = value.replace(/["\u0000-\u001f\u007f]/g, '').trim();
  return `"${clean}"`;
}

/** An address as a mailto: URI, refused when it could break the line. */
function mailto(email: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (!/^[^\s@<>"\u0000-\u001f]+@[^\s@<>"\u0000-\u001f]+$/.test(email))
    throw new Error(`Not an email address: ${email}`);
  return `mailto:${email}`;
}

/**
 * One content line, folded: at most 75 octets per line, continuations start with a space. A
 * multi-byte character is never split.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    // The first line holds 75 octets; each continuation 74 after its leading space.
    const limit = out.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      out.push(current);
      current = '';
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function person(name: 'ORGANIZER' | 'ATTENDEE', p: IcsPerson, extra: string[] = []): string {
  const params = [...(p.name ? [`CN=${paramValue(p.name)}`] : []), ...extra];
  return `${name}${params.length ? `;${params.join(';')}` : ''}:${mailto(p.email)}`;
}

function eventLines(e: IcsEvent, method: IcsCalendar['method']): string[] {
  const start = icsDate(e.start);
  const end = icsDate(e.end);
  if (end <= start) throw new Error(`Event ${e.uid} ends before it starts`);
  if (!e.uid || /[\r\n]/.test(e.uid)) throw new Error('An event needs a one-line UID');
  const status = e.status ?? (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED');
  return [
    'BEGIN:VEVENT',
    `UID:${icsText(e.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(e.sequence ?? 0))}`,
    `DTSTAMP:${icsDate(e.stamp ?? new Date())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsText(e.title)}`,
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    ...(e.url ? [`URL:${e.url.replace(/[\r\n]/g, '')}`] : []),
    `STATUS:${status}`,
    ...(e.organizer ? [person('ORGANIZER', e.organizer)] : []),
    ...(e.attendees ?? []).map((a) =>
      person('ATTENDEE', a, [
        'ROLE=REQ-PARTICIPANT',
        `PARTSTAT=${status === 'CANCELLED' ? 'DECLINED' : 'NEEDS-ACTION'}`,
        `RSVP=${e.rsvp ? 'TRUE' : 'FALSE'}`,
      ]),
    ),
    'END:VEVENT',
  ];
}

/** A whole calendar object, CRLF line ends, folded: what an .ics file or a feed holds. */
export function icsCalendar(cal: IcsCalendar): string {
  if (cal.method && cal.method !== 'PUBLISH' && cal.events.some((e) => !e.organizer))
    throw new Error(`An iTIP ${cal.method} needs an organizer on every event`);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${cal.prodId.replace(/[\r\n]/g, '')}`,
    'CALSCALE:GREGORIAN',
    ...(cal.method ? [`METHOD:${cal.method}`] : []),
    ...(cal.name ? [`X-WR-CALNAME:${icsText(cal.name)}`] : []),
    ...cal.events.flatMap((e) => eventLines(e, cal.method)),
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
