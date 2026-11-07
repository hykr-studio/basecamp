import { describe, expect, it } from 'vitest';
import { foldLine, icsCalendar, icsDate, icsText } from './ics.js';

const event = {
  uid: 'task-1@example.test',
  start: '2026-11-07T09:30:00.000Z',
  end: '2026-11-07T10:00:00+00:00',
  title: 'Review, plan; agree',
  stamp: '2026-11-01T00:00:00Z',
};

describe('icsDate', () => {
  it('writes UTC in the basic form, whatever the offset given', () => {
    expect(icsDate('2026-11-07T15:00:00+05:30')).toBe('20261107T093000Z');
    expect(icsDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('20260102T030405Z');
    expect(() => icsDate('soon')).toThrow(/Not a date/);
  });
});

describe('icsText', () => {
  it('escapes backslash, semicolon, comma and line breaks, and drops control bytes', () => {
    expect(icsText('a\\b;c,d\r\ne\u0007f')).toBe('a\\\\b\\;c\\,d\\ne' + 'f');
  });
});

describe('foldLine', () => {
  it('keeps lines within 75 octets and never splits a character', () => {
    const line = `SUMMARY:${'é'.repeat(100)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n'))
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
});

describe('icsCalendar', () => {
  it('writes a feed: no method, CRLF line ends, the events', () => {
    const text = icsCalendar({ prodId: '-//Test//Feed//EN', name: 'Mine', events: [event] });
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text).not.toContain('METHOD:');
    expect(text).toContain('X-WR-CALNAME:Mine');
    expect(text).toContain('DTSTART:20261107T093000Z');
    expect(text).toContain('DTEND:20261107T100000Z');
    expect(text).toContain('SUMMARY:Review\\, plan\\; agree');
    expect(text).toContain('STATUS:CONFIRMED');
    expect(text).toContain('SEQUENCE:0');
    expect(text.split('\r\n').filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('writes an invite with its organizer and attendees, and a cancellation', () => {
    const invite = {
      ...event,
      sequence: 2,
      organizer: { email: 'from@example.test', name: 'The "Business"' },
      attendees: [{ email: 'to@example.test', name: 'Ana' }],
    };
    const request = icsCalendar({ method: 'REQUEST', prodId: '-//T//T//EN', events: [invite] });
    expect(request).toContain('METHOD:REQUEST');
    expect(request).toContain('ORGANIZER;CN="The Business":mailto:from@example.test');
    expect(request.replace(/\r\n /g, '')).toContain(
      'ATTENDEE;CN="Ana";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:to@example.test',
    );
    expect(request).toContain('SEQUENCE:2');
    const cancel = icsCalendar({ method: 'CANCEL', prodId: '-//T//T//EN', events: [invite] });
    expect(cancel).toContain('METHOD:CANCEL');
    expect(cancel).toContain('STATUS:CANCELLED');
  });

  it('refuses what would break the text', () => {
    expect(() => icsCalendar({ method: 'REQUEST', prodId: 'x', events: [event] })).toThrow(
      /organizer/,
    );
    expect(() => icsCalendar({ prodId: 'x', events: [{ ...event, end: event.start }] })).toThrow(
      /ends before/,
    );
    expect(() =>
      icsCalendar({
        method: 'REQUEST',
        prodId: 'x',
        events: [{ ...event, organizer: { email: 'a@b.c\r\nX-EVIL:1' } }],
      }),
    ).toThrow(/email/);
  });
});
