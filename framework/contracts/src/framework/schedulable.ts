/**
 * Records with a time: an entity says which of its fields are the title, the start and the end
 * (and the place and a description), and whose calendars it belongs on. The calendar feature
 * puts such records in connected calendars, invites people to them and lists them in feeds.
 *
 *   traits: {
 *     schedulable: { title: 'title', startsAt: 'startsAt', endsAt: 'endsAt', location: 'address' },
 *   },
 */
import type { EntitySpec } from './spec.js';

declare module './traits.js' {
  interface EntityTraits {
    /** Its records are events in calendars. */
    schedulable?: SchedulableTrait;
  }
}

export interface SchedulableTrait {
  /** Read-schema fields: the event's title, and its start and end (ISO date-times). */
  title: string;
  startsAt: string;
  endsAt: string;
  /** A read-schema field with the place: text, or an `Address`. */
  location?: string;
  /** A read-schema field with text for the event's description. */
  description?: string;
  /**
   * Columns of the table holding the ids of the people whose calendars it belongs on (one id or
   * a list). Default: the owner column.
   */
  people?: readonly string[];
  /** Records off every calendar while `field` has one of these values (cancelled). */
  hiddenWhen?: { field: string; in: readonly unknown[] };
}

/** The trait, if the spec carries it. */
export const schedulableOf = (spec: Pick<EntitySpec, 'traits'>): SchedulableTrait | undefined =>
  spec.traits?.schedulable;

/** What is wrong with a spec's trait: fields its read schema does not have. */
export function schedulableProblems(spec: EntitySpec): string[] {
  const trait = schedulableOf(spec);
  if (!trait) return [];
  const shape = (spec.schemas.read as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  const fields = [
    trait.title,
    trait.startsAt,
    trait.endsAt,
    trait.location,
    trait.description,
    trait.hiddenWhen?.field,
  ].filter((f): f is string => !!f);
  return fields
    .filter((f) => !(f in shape))
    .map((f) => `${spec.name}: the schedulable trait names "${f}", which its read schema lacks`);
}

/* ── Free time ─────────────────────────────────────────────────────────────── */

export interface Interval {
  start: string;
  end: string;
}

export interface FreeSlotOptions {
  /** The window to look in (ISO date-times). */
  from: string;
  to: string;
  /** How long each slot is. */
  minutes: number;
  /** Minutes between slot starts. Default: `minutes`. */
  stepMinutes?: number;
  /** Only slots that start and end inside these local hours ('09:00' to '18:00'). */
  hours?: { from: string; to: string };
  /** The zone `hours` and slot alignment are in (IANA). Default UTC. */
  timeZone?: string;
  /** Mondays to Sundays as 1 to 7: only these local days. Default every day. */
  days?: readonly number[];
  /** At most this many slots. Default 50. */
  limit?: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`"${hhmm}" is not a time like 09:00`);
  return Number(m[1]) * 60 + Number(m[2]);
};

const formats = new Map<string, Intl.DateTimeFormat>();
const formatIn = (timeZone: string) => {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(timeZone, f);
  }
  return f;
};

/** The zone's offset from UTC at this moment, in minutes (IST: 330). */
export function zoneOffsetMinutes(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatIn(timeZone)
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((local - Math.floor(at / 1000) * 1000) / 60_000);
}

const MINUTE = 60_000;

/**
 * The free slots in a window, given busy intervals: each `minutes` long, starting on the local
 * step grid, overlapping nothing busy, and inside the local hours and days when given.
 */
export function freeSlots(busy: readonly Interval[], o: FreeSlotOptions): Interval[] {
  const from = Date.parse(o.from);
  const to = Date.parse(o.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const length = Math.round(o.minutes) * MINUTE;
  const step = Math.round(o.stepMinutes ?? o.minutes) * MINUTE;
  if (length <= 0 || step <= 0) throw new Error('A slot and its step must be at least a minute');
  const zone = o.timeZone ?? 'UTC';
  const open = o.hours ? minutesOf(o.hours.from) : 0;
  const close = o.hours ? minutesOf(o.hours.to) : 24 * 60;
  const limit = o.limit ?? 50;
  const blocked = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const out: Interval[] = [];
  // The first start on the grid, in local time.
  const offset0 = zoneOffsetMinutes(from, zone) * MINUTE;
  let start = Math.ceil((from + offset0) / step) * step - offset0;
  // At most a year of steps: a bound on the work, whatever the window.
  for (let i = 0; start + length <= to && out.length < limit && i < 525_600; i++, start += step) {
    const end = start + length;
    const offset = zoneOffsetMinutes(start, zone) * MINUTE;
    const localStart = start + offset;
    const dayStart = Math.floor(localStart / (1440 * MINUTE)) * 1440 * MINUTE;
    const startMin = (localStart - dayStart) / MINUTE;
    const endMin = startMin + length / MINUTE;
    if (startMin < open || endMin > close) continue;
    if (o.days) {
      const weekday = ((new Date(dayStart).getUTCDay() + 6) % 7) + 1;
      if (!o.days.includes(weekday)) continue;
    }
    if (blocked.some((b) => b.start < end && b.end > start)) continue;
    out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return out;
}
