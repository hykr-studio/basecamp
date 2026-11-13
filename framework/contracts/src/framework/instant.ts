// A time someone sends (`before=`, `since=`, a list's date filter, a cursor's time): JavaScript
// reads more than Postgres stores. `new Date('99999')` is a valid Date in the year 99999, which
// drizzle sends as '+099998-12-31T…', and `z.iso.datetime()` takes the year 0000: Postgres
// refuses both, a 500 for the request (docs/decisions/V1.md, V10.md).
import { z } from 'zod';

/** The instant this text names, when Postgres can store it (years 1 to 9999); else undefined. */
export function storableInstant(text: unknown): Date | undefined {
  if (typeof text !== 'string' || text === '') return undefined;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return undefined;
  const year = at.getUTCFullYear();
  return year >= 1 && year <= 9999 ? at : undefined;
}

const STORABLE = 'A time from the year 1 to 9999';

/**
 * A text Postgres can store, judged as the instant it names in UTC (years 1 to 9999) and as the
 * text itself: `0000-12-31T23:30:00-01:00` is UTC 0001-01-01, but a `date` column, or a timestamp
 * kept as text, gets the text, whose year 0000 Postgres refuses (22008). So no reader of the text
 * depends on which it sends.
 */
const storableText = (v: string) => !v.startsWith('0000-') && storableInstant(v) !== undefined;

/**
 * `z.iso.datetime(opts)`, refusing a time Postgres cannot store: written in the year 0000, or
 * in the year 0000 or past 9999 in UTC.
 */
export const storableDateTime = (opts?: { offset?: boolean }) =>
  z.iso.datetime(opts).refine(storableText, STORABLE);

/** `z.iso.date()`, refusing the year 0000, which Postgres's date has no room for. */
export const storableDate = () => z.iso.date().refine(storableText, STORABLE);
