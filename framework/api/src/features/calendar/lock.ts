// One job at a time per record (its calendar events) and per invite: each job reads, sends and
// records in turn, so a slower job never overwrites what a later one sent (decisions B17, 33).
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { config } from '../../config.js';

const log = new Logger('CalendarLocks');

export interface LockOptions {
  /** Most holders at once in this process: the size of the locks' own pool. */
  holders: number;
  /** How long a holder waits for a connection of that pool, and then for the lock itself. */
  waitMs: number;
}

/**
 * Postgres advisory locks on a small pool of their own. A holder keeps one connection of it in a
 * transaction that does nothing else while `fn` runs, and `fn` reads and writes through the main
 * pool, each write committing as it goes. So holders never take the connections their work
 * needs: however many jobs hold or wait, the main pool keeps serving them and everything else.
 * The pool's size bounds the holders of one process; the rest wait their turn for a connection.
 * A wait longer than `waitMs`, for the connection or for the lock, fails the job (which retries).
 * A holder that dies lets go with its connection.
 */
export class AdvisoryLocks {
  private readonly pool: pg.Pool;

  constructor(
    url: string,
    private readonly o: LockOptions,
  ) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: o.holders,
      connectionTimeoutMillis: o.waitMs,
    });
    // A lost idle connection is the pool's to replace, not a crash.
    this.pool.on('error', (e) => log.warn(`lock connection: ${e.message}`));
  }

  /** `fn` while this process holds the lock `key`, one holder at a time across every process. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    const lost = (e: Error) => {
      broken = e;
      log.warn(`lock ${key}: ${e.message}`);
    };
    client.on('error', lost);
    try {
      await client.query('begin');
      await client.query("select set_config('lock_timeout', $1, true)", [`${this.o.waitMs}ms`]);
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      return await fn();
    } finally {
      // Ending the transaction lets go of the lock.
      await client.query('rollback').catch((e: Error) => {
        broken ??= e;
      });
      client.removeListener('error', lost);
      client.release(broken);
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

/** Most calendar jobs of one process that hold a lock, or wait in Postgres for one, at once. */
const HOLDERS = 4;
/** How long a job waits for another to finish with the same thing, before it fails and retries. */
const WAIT_MS = 60_000;

/** The calendar's locks, one pool per application, closed with it. */
@Injectable()
export class CalendarLocks implements OnApplicationShutdown {
  private readonly locks = new AdvisoryLocks(config.databaseUrl, {
    holders: HOLDERS,
    waitMs: WAIT_MS,
  });

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(key, fn);
  }

  onApplicationShutdown() {
    return this.locks.end();
  }
}

export const recordLock = (tenantId: string, entity: string, id: string) =>
  `calendar.record:${tenantId}:${entity}:${id}`;

export const inviteLock = (inviteId: string) => `calendar.invite:${inviteId}`;
