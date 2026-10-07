/** Local calendar helpers: the app shows and enters times in the person's own time zone. */
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
