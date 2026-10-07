/** Words for dates and times, in the person's time zone; no ids, no ISO strings. */

/** "Mon 5 Oct", from YYYY-MM-DD. */
export function dayText(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "Mon 5 Oct, 14:30", from an ISO date-time. */
export function whenText(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

/** "14:30". */
export function clockText(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

/** "3 to-dos", "1 to-do". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first few names, then "and N more". */
export function firstFew(names: string[], n = 3): string {
  if (names.length <= n) return names.join(', ');
  return `${names.slice(0, n).join(', ')}, and ${names.length - n} more`;
}
