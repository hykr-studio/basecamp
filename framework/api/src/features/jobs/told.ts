// What a job keeps of an error that stopped it: its `error.message`, an update's outcome, the
// answer to a callback it could not read. Its starter reads these (`GET /api/jobs/:id`), so a
// database error's query, parameters and row values stay in the server's log (docs/decisions/
// V10.md), and the text is one Postgres keeps, else the job's own row could not record it.
import { storableText } from '@hykr/contracts';

/** A database's error: drizzle's (`Failed query: … params: …`) or the driver's (a SQLSTATE). */
export function fromDatabase(e: unknown): boolean {
  let x = e as { name?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; x && typeof x === 'object' && depth < 5; depth++) {
    if (x.name === 'DrizzleQueryError' || x.name === 'PostgresError') return true;
    if (typeof x.message === 'string' && x.message.startsWith('Failed query:')) return true;
    x = x.cause as typeof x;
  }
  return false;
}

/** What a database error tells the job's starter. */
export const DATABASE_ERROR = 'A database error stopped this work';

/**
 * The error as its job keeps it: one line of at most 500 characters, a database's error as
 * `DATABASE_ERROR`, and nothing Postgres cannot keep (a cut may halve a surrogate pair; a
 * parser's message may repeat a NUL from the file).
 */
export function told(e: unknown): string {
  if (fromDatabase(e)) return DATABASE_ERROR;
  return storableText((e instanceof Error ? e.message : String(e)).slice(0, 500));
}
