// Time that counts only while a business is open: its week of opening hours and its holidays,
// in its own time zone. Pure (Intl only), so the server computes SLA deadlines with it and an
// app shows the same countdown. docs/decisions/B6B4.md.

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Open from one wall-clock time to another on the same day: '09:00' to '18:00' ('24:00': midnight). */
export interface OpenInterval {
  from: string;
  to: string;
}

/** When a business is open. No week: every hour of every day that is not a holiday. */
export interface OpenHours {
  week?: Partial<Record<Weekday, readonly OpenInterval[]>>;
  /** Whole days closed, as local dates: '2026-01-26'. */
  holidays?: readonly string[];
}

const MINUTE = 60_000;
/** Ten years of days: a search that finds no open time by then gives up. */
const MAX_DAYS = 3660;

/** Minutes after midnight of 'HH:MM'. */
export function minutesOf(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`"${hhmm}" is not a time of day (HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0))
    throw new Error(`"${hhmm}" is not a time of day`);
  return h * 60 + min;
}

type LocalDay = { y: number; m: number; d: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in a zone at an instant. */
function wallClock(at: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    y: part('year'),
    m: part('month'),
    d: part('day'),
    h: part('hour') % 24,
    min: part('minute'),
    s: part('second'),
  };
}

/** How far a zone's wall clock is ahead of UTC at an instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const w = wallClock(at, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a local wall-clock time happens in a zone (a time skipped by DST moves on). */
function instantOf(day: LocalDay, minutes: number, timeZone: string): number {
  const guess = Date.UTC(day.y, day.m - 1, day.d) + minutes * MINUTE;
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

const localDay = (at: number, timeZone: string): LocalDay => {
  const { y, m, d } = wallClock(at, timeZone);
  return { y, m, d };
};
const nextDay = ({ y, m, d }: LocalDay): LocalDay => {
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const iso = ({ y, m, d }: LocalDay) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const weekdayOf = ({ y, m, d }: LocalDay): Weekday =>
  WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

const ALL_DAY: readonly OpenInterval[] = [{ from: '00:00', to: '24:00' }];

/** One local day's open spans, as instants, in order. */
function openSpans(day: LocalDay, hours: OpenHours, timeZone: string): [number, number][] {
  if (hours.holidays?.includes(iso(day))) return [];
  const intervals = hours.week ? (hours.week[weekdayOf(day)] ?? []) : ALL_DAY;
  return intervals
    .map(
      (i) =>
        [
          instantOf(day, minutesOf(i.from), timeZone),
          instantOf(day, minutesOf(i.to), timeZone),
        ] as [number, number],
    )
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
}

const everyHour = (hours: OpenHours | undefined) => !hours?.week && !hours?.holidays?.length;

/**
 * The moment `ms` of open time after `start` has passed. Closed time (nights, closed days,
 * holidays) does not count. With no week and no holidays, simply `start + ms`.
 */
export function addBusinessTime(
  start: Date,
  ms: number,
  hours: OpenHours | undefined,
  timeZone: string,
): Date {
  if (ms <= 0 || everyHour(hours)) return new Date(start.getTime() + Math.max(ms, 0));
  const h = hours as OpenHours;
  let left = ms;
  let day = localDay(start.getTime(), timeZone);
  for (let i = 0; i < MAX_DAYS; i++, day = nextDay(day)) {
    for (const [from, to] of openSpans(day, h, timeZone)) {
      const a = Math.max(from, start.getTime());
      if (to <= a) continue;
      if (left <= to - a) return new Date(a + left);
      left -= to - a;
    }
  }
  // No open time for ten years (a week with no hours is refused in settings): count every hour.
  return new Date(start.getTime() + ms);
}

/**
 * The open time between two moments, as spans of instants in order: one span where the business
 * stays open across a boundary (a day open to 24:00 and the next from 00:00). With no week and
 * no holidays, the whole window.
 */
export function openSpansBetween(
  start: Date,
  end: Date,
  hours: OpenHours | undefined,
  timeZone: string,
): { start: number; end: number }[] {
  const a0 = start.getTime();
  const b0 = end.getTime();
  if (b0 <= a0) return [];
  if (everyHour(hours)) return [{ start: a0, end: b0 }];
  const h = hours as OpenHours;
  const out: { start: number; end: number }[] = [];
  let day = localDay(a0, timeZone);
  for (let i = 0; i < MAX_DAYS; i++, day = nextDay(day)) {
    for (const [from, to] of openSpans(day, h, timeZone)) {
      const a = Math.max(from, a0);
      const b = Math.min(to, b0);
      if (b <= a) continue;
      const last = out[out.length - 1];
      if (last && a <= last.end) last.end = Math.max(last.end, b);
      else out.push({ start: a, end: b });
    }
    if (instantOf(nextDay(day), 0, timeZone) >= b0) break;
  }
  return out;
}

/** How much open time lies between two moments (0 when `end` is not after `start`). */
export function businessTimeBetween(
  start: Date,
  end: Date,
  hours: OpenHours | undefined,
  timeZone: string,
): number {
  const a0 = start.getTime();
  const b0 = end.getTime();
  if (b0 <= a0) return 0;
  if (everyHour(hours)) return b0 - a0;
  const h = hours as OpenHours;
  let total = 0;
  let day = localDay(a0, timeZone);
  for (let i = 0; i < MAX_DAYS; i++, day = nextDay(day)) {
    const spans = openSpans(day, h, timeZone);
    for (const [from, to] of spans) {
      const a = Math.max(from, a0);
      const b = Math.min(to, b0);
      if (b > a) total += b - a;
    }
    if (instantOf(nextDay(day), 0, timeZone) >= b0) break;
  }
  return total;
}
