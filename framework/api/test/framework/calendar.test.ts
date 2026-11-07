// Calendar helpers without a server: free slots between busy times, in a business's zone, and
// the schedulable trait's own checks.
import { entitySpec, freeSlots, schedulableProblems, zoneOffsetMinutes } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('freeSlots', () => {
  const from = '2026-11-09T00:00:00.000Z';
  const to = '2026-11-09T06:00:00.000Z';

  it('steps through the window, skipping busy times', () => {
    const slots = freeSlots([{ start: '2026-11-09T01:30:00Z', end: '2026-11-09T03:00:00Z' }], {
      from,
      to,
      minutes: 60,
    });
    expect(slots.map((s) => s.start.slice(11, 16))).toEqual(['00:00', '03:00', '04:00', '05:00']);
  });

  it('keeps to local working hours and days, on the local grid', () => {
    // Asia/Kolkata is UTC+5:30: 09:00 there is 03:30 UTC.
    const slots = freeSlots([], {
      from: '2026-11-09T00:00:00Z',
      to: '2026-11-10T00:00:00Z',
      minutes: 60,
      timeZone: 'Asia/Kolkata',
      hours: { from: '09:00', to: '12:00' },
    });
    expect(slots.map((s) => s.start)).toEqual([
      '2026-11-09T03:30:00.000Z',
      '2026-11-09T04:30:00.000Z',
      '2026-11-09T05:30:00.000Z',
    ]);
    // 9 November 2026 is a Monday (1) there; only Tuesdays (2): nothing that day.
    expect(
      freeSlots([], {
        from: '2026-11-09T00:00:00+05:30',
        to: '2026-11-10T00:00:00+05:30',
        minutes: 60,
        timeZone: 'Asia/Kolkata',
        days: [2],
      }),
    ).toEqual([]);
  });

  it('starts on the next step, and stops at the limit', () => {
    const slots = freeSlots([], {
      from: '2026-11-09T00:10:00Z',
      to,
      minutes: 30,
      stepMinutes: 15,
      limit: 3,
    });
    expect(slots.map((s) => s.start.slice(11, 16))).toEqual(['00:15', '00:30', '00:45']);
    expect(freeSlots([], { from: to, to: from, minutes: 30 })).toEqual([]);
    expect(() => freeSlots([], { from, to, minutes: 0 })).toThrow();
  });

  it('knows a zone’s offset at a moment', () => {
    expect(zoneOffsetMinutes(Date.parse('2026-11-09T00:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(zoneOffsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Europe/Berlin')).toBe(120);
    expect(zoneOffsetMinutes(Date.parse('2026-12-01T12:00:00Z'), 'Europe/Berlin')).toBe(60);
  });
});

describe('the schedulable trait', () => {
  const read = z.object({ id: z.string(), title: z.string(), at: z.string(), until: z.string() });
  const spec = (schedulable: Record<string, unknown>) =>
    entitySpec({
      name: 'thing',
      label: 'thing',
      description: 'Things.',
      schemas: { read, create: z.object({}), update: z.object({}) },
      list: {
        filterable: {},
        sortable: [],
        defaultSort: [['id', 'asc']],
        pageSize: { default: 10, max: 10 },
      },
      traits: { schedulable: schedulable as never },
    });

  it('names fields its read schema has', () => {
    expect(schedulableProblems(spec({ title: 'title', startsAt: 'at', endsAt: 'until' }))).toEqual(
      [],
    );
    expect(
      schedulableProblems(
        spec({ title: 'title', startsAt: 'at', endsAt: 'until', location: 'place' }),
      ),
    ).toEqual(['thing: the schedulable trait names "place", which its read schema lacks']);
  });
});
