import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../database.js';
import { numberSeries } from '../schema/numbering.js';

/**
 * The next number of a series in this business and period, starting at 1. One upsert in the
 * caller's transaction: it locks the counter row (as SELECT … FOR UPDATE would) until that
 * transaction ends, so a concurrent write waits, and a rollback gives the number back.
 */
export async function takeNumber(
  tx: DbOrTx,
  key: { tenantId: string; series: string; period: string },
): Promise<number> {
  const [row] = await tx
    .insert(numberSeries)
    .values({ ...key, last: 1 })
    .onConflictDoUpdate({
      target: [numberSeries.tenantId, numberSeries.series, numberSeries.period],
      set: { last: sql`${numberSeries.last} + 1`, updatedAt: sql`now()` },
    })
    .returning({ last: numberSeries.last });
  if (!row) throw new Error(`No number was taken for ${key.series}`);
  return row.last;
}
