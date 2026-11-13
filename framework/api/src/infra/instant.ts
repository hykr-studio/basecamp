// A time sent in a query string (`before=`, `since=`): JavaScript reads more than Postgres stores.
// `new Date('99999')` is a valid Date in the year 99999, which drizzle sends as
// '+099998-12-31T…' and Postgres refuses: a 500 for the request (docs/decisions/V1.md).

/** The instant this text names, when Postgres can store it (years 1 to 9999); else undefined. */
export function storableInstant(text: unknown): Date | undefined {
  if (typeof text !== 'string' || text === '') return undefined;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return undefined;
  const year = at.getUTCFullYear();
  return year >= 1 && year <= 9999 ? at : undefined;
}
