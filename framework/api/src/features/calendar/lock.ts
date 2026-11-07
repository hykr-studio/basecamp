// One job at a time per record (its calendar events) and per invite: each job reads, sends and
// records in turn, so a slower job never overwrites what a later one sent (decisions B17, 33).
import type { Database } from '@hykr/db';
import { sql } from 'drizzle-orm';

/** How long a job waits for another to finish with the same thing, before it fails and retries. */
const WAIT_MS = 60_000;

/**
 * `fn` while this process holds the advisory lock `key`, one holder at a time across every
 * process on the database. A transaction that does nothing else holds it, so `fn` reads and
 * writes through the pool and each write commits as it goes; a holder that dies lets go with its
 * connection. Each holder takes one connection of the pool for as long as `fn` runs.
 */
export function withLock<T>(db: Database, key: string, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', ${`${WAIT_MS}ms`}, true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return fn();
  });
}

export const recordLock = (tenantId: string, entity: string, id: string) =>
  `calendar.record:${tenantId}:${entity}:${id}`;

export const inviteLock = (inviteId: string) => `calendar.invite:${inviteId}`;
