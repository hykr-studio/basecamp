/** "4 min", "2 h", "3 d": how long ago, or how long left. */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export const ago = (iso: string, now = Date.now()) => `${span(now - new Date(iso).getTime())} ago`;

/** The 24-hour window: open with time left, closing soon, or closed. */
export function windowOf(endsAt: string | null, now = Date.now()) {
  if (!endsAt) return { state: 'closed' as const, label: 'No message yet' };
  const left = new Date(endsAt).getTime() - now;
  if (left <= 0) return { state: 'closed' as const, label: 'Window closed' };
  if (left < 2 * 60 * 60 * 1000) return { state: 'closing' as const, label: `${span(left)} left` };
  return { state: 'open' as const, label: `${span(left)} left` };
}

export const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
