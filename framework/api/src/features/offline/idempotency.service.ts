import { CORE_OPTIONS, type CoreOptions } from '@hykr/core';
import { idempotencyKeys } from '@hykr/db';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement, so a large purge never holds a long lock. */
const BATCH = 5000;

/**
 * How long a write's stored reply is kept for a retry with the same idempotency key:
 * `IDEMPOTENCY_KEEP_DAYS` (whole days, at least 1), 30 by default. A device offline longer than
 * this may send a queued write whose first try reached the server; it then runs again (a create
 * with a client-chosen id answers 409 `id_taken` instead). Read when called.
 */
export function idempotencyKeepDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IDEMPOTENCY_KEEP_DAYS;
  if (raw === undefined || raw.trim() === '') return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      `IDEMPOTENCY_KEEP_DAYS must be a whole number of days, at least 1 (got "${raw}")`,
    );
  return n;
}

/** Forgets the stored replies of writes older than the retention (`app.idempotency`). */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  /** Delete replies stored before `now` minus the retention, a batch at a time. */
  async purge(now: Date = new Date()): Promise<{ deleted: number }> {
    const before = new Date(now.getTime() - idempotencyKeepDays() * DAY_MS);
    let deleted = 0;
    for (;;) {
      const gone = await this.options.db.execute(
        sql`delete from ${idempotencyKeys} where ctid in (
          select ctid from ${idempotencyKeys} where ${idempotencyKeys.createdAt} < ${before} limit ${BATCH}
        )`,
      );
      const n = Number((gone as { rowCount?: number | null }).rowCount ?? 0);
      deleted += n;
      if (n < BATCH) return { deleted };
    }
  }
}
