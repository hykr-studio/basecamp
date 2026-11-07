// The calendar's advisory locks (decisions B17, 33), on the test database without a server: one
// holder per key across pools, more holders than any pool has connections, and bounded waits.
import { createDb } from '@hykr/db';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { AdvisoryLocks } from '../../dist/features/calendar/lock.js';

const url = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unique = () => `test.lock:${Math.random().toString(36).slice(2)}`;

const opened: { end(): Promise<void> }[] = [];
const locksOf = (holders: number, waitMs: number) => {
  const locks = new AdvisoryLocks(url, { holders, waitMs });
  opened.push(locks);
  return locks;
};
/** A main pool as small as we like: the work inside a lock reads and writes through it. */
const mainOf = (max: number) => {
  const main = createDb(url, { max, connectionTimeoutMillis: 5_000 });
  opened.push(main.pool);
  return main.db;
};

afterAll(async () => {
  for (const o of opened) await o.end().catch(() => {});
});

describe('AdvisoryLocks', () => {
  it('runs more holders than either pool has connections, one per key at a time', async () => {
    // The main pool has two connections and so do the locks; twelve jobs on three keys each
    // read, then write in a transaction of their own, through the main pool while they hold.
    const db = mainOf(2);
    const locks = locksOf(2, 5_000);
    const keys = [unique(), unique(), unique()];
    const inside = new Map<string, number>();
    let most = 0;
    let holding = 0;
    let mostHolding = 0;
    const job = (key: string) =>
      locks.run(key, async () => {
        holding++;
        mostHolding = Math.max(mostHolding, holding);
        inside.set(key, (inside.get(key) ?? 0) + 1);
        most = Math.max(most, inside.get(key) ?? 0);
        await db.execute(sql`select 1`);
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_sleep(0.02)`);
        });
        await db.execute(sql`select 1`);
        inside.set(key, (inside.get(key) ?? 1) - 1);
        holding--;
        return key;
      });
    const all = Promise.all(Array.from({ length: 12 }, (_, i) => job(keys[i % 3])));
    const done = await Promise.race([all, sleep(15_000).then(() => 'hung' as const)]);
    expect(done).not.toBe('hung');
    expect(done).toHaveLength(12);
    // One holder per key, and never more holders than the locks' pool has connections.
    expect(most).toBe(1);
    expect(mostHolding).toBeLessThanOrEqual(2);
  });

  it('keeps one holder per key across pools, as across processes', async () => {
    const [a, b] = [locksOf(2, 5_000), locksOf(2, 5_000)];
    const key = unique();
    const order: string[] = [];
    const first = a.run(key, async () => {
      order.push('a in');
      await sleep(300);
      order.push('a out');
    });
    await sleep(50);
    await b.run(key, async () => {
      order.push('b in');
    });
    await first;
    expect(order).toEqual(['a in', 'a out', 'b in']);
  });

  it('lets go when the work throws', async () => {
    const locks = locksOf(1, 2_000);
    const key = unique();
    await expect(
      locks.run(key, async () => {
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    const started = Date.now();
    expect(await locks.run(key, async () => 'next')).toBe('next');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('fails a holder that waits too long, for the lock or for a connection', async () => {
    const key = unique();
    // Holding is not waiting: this holder keeps its lock past its own wait time.
    const holder = locksOf(1, 400);
    const held = holder.run(key, () => sleep(1_500));
    await sleep(100);
    // Another process waits for the same key: past its wait, Postgres refuses (lock_timeout).
    await expect(locksOf(1, 300).run(key, async () => 'never')).rejects.toMatchObject({
      code: '55P03',
    });
    // This process's only lock connection is taken: another key waits for it, then fails.
    await expect(holder.run(unique(), async () => 'never')).rejects.toThrow(/timeout/);
    await held;
  });
});
