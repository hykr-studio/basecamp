/** Local calendar helpers: the app shows and enters times in the person's own time zone. */
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const todayLocal = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD

export function dayBounds(date = todayLocal()) {
  return {
    gte: new Date(`${date}T00:00:00`).toISOString(),
    lte: new Date(`${date}T23:59:59.999`).toISOString(),
  };
}

/** A local date + HH:MM → ISO instant. */
export const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const DAY = 86_400_000;
const dayNumber = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`) / DAY;

/** A due date as people say it: today, tomorrow, in 3 days, 2 days overdue. */
export function relativeDay(ymd: string): { text: string; overdue: boolean } {
  const diff = Math.round(dayNumber(ymd) - dayNumber(todayLocal()));
  if (diff === 0) return { text: 'due today', overdue: false };
  if (diff === 1) return { text: 'due tomorrow', overdue: false };
  if (diff === -1) return { text: '1 day overdue', overdue: true };
  if (diff < 0) return { text: `${-diff} days overdue`, overdue: true };
  if (diff < 7) return { text: `due in ${diff} days`, overdue: false };
  return {
    text: `due ${dayLabel(ymd)}`,
    overdue: false,
  };
}

/** "expires in 23 h", "expires in 40 min", "expired". */
export function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  return `expires in ${Math.round(minutes / 60)} h`;
}

export const isValidDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const isValidTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** One date style everywhere in the app: "Mon 5 Oct". */
export const dayLabel = (ymd: string) =>
  new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
