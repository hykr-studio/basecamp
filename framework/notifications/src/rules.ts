/**
 * When a notification may go out: never in the business's quiet hours (9pm to 9am by default),
 * in the business's own time zone. Pure, so it is tested without a clock or a queue.
 */
export type QuietHours = { from: string; to: string; timeZone: string };

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Minutes past midnight, in that zone, and the zone's offset from UTC (minutes). */
function local(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return {
    minute: get('hour') * 60 + get('minute'),
    offset: Math.round((asUtc - at.getTime()) / 60_000),
  };
}

/**
 * The moment quiet hours end, if `at` falls inside them; null when it may go now. Handles
 * quiet hours that cross midnight (21:00 to 09:00) and those that don't.
 */
export function quietUntil(at: Date, q: QuietHours): Date | null {
  const { minute } = local(at, q.timeZone);
  const from = minutes(q.from);
  const to = minutes(q.to);
  const inside = from > to ? minute >= from || minute < to : minute >= from && minute < to;
  if (!inside) return null;
  // Minutes until `to`, wrapping past midnight.
  const wait = (to - minute + 24 * 60) % (24 * 60);
  const end = new Date(at.getTime() + wait * 60_000);
  end.setUTCSeconds(0, 0);
  return end;
}

/** Marketing: at most `perWeek` per customer; the count is of the last 7 days' sends. */
export const underMarketingCap = (sentThisWeek: number, perWeek: number) => sentThisWeek < perWeek;
