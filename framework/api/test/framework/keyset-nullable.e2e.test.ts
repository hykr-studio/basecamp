// A list sorted by a nullable time pages every row once, in any session time zone
// (docs/decisions/V12.md, decision 13). Rows with no time sort as a far-off one (`sortExpr`'s
// coalesce), and the cursor keeps that time as Postgres prints it (`exactTime`). A column with no
// zone was coalesced with a `timestamptz` far value, so its sort expression changed type: in a
// session west of UTC the far-off year 1 printed as the last day of 1 BC with no era
// ('0001-12-31T19:03:58'), the next page compared against AD 1, and a walk descending into the
// rows with no time never ended. Postgres's session zone is the server's or the host's: nothing
// pins it, so the list must not depend on it.
//
// The first part walks @hykr/core's list builder on a temporary table, with no server, in four
// session zones, on one connection (the table and the zone are that session's own). The second
// walks a nullable time with a zone over HTTP, on the summary fixture's entries.
import { entitySpec, listQuerySchema } from '@hykr/contracts';
import { buildListSql, decodeCursor } from '@hykr/core';
import { createDb } from '@hykr/db';
import { and, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pool as appPool, boot, me, Person, shutdown } from '../../dist/testing.js';
import { summaryServer } from '../fixture/dist/features/summary/index.js';

const url = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';
const temp = pgSchema('pg_temp');
const times = temp.table('keyset_zones', {
  id: text('id').primaryKey(),
  seenAt: timestamp('seen_at', { withTimezone: true }),
  naiveAt: timestamp('naive_at'),
  naiveText: timestamp('naive_text', { mode: 'string' }),
  title: text('title').notNull(),
});
const Row = z.object({
  id: z.string(),
  seenAt: z.string().nullable(),
  naiveAt: z.string().nullable(),
  naiveText: z.string().nullable(),
  title: z.string(),
});
const Spec = entitySpec({
  name: 'keysetZonesRow',
  label: 'row',
  description: 'Rows with nullable times, with and without a zone.',
  schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
  list: {
    filterable: {},
    sortable: ['seenAt', 'naiveAt', 'naiveText', 'title'],
    defaultSort: [['title', 'asc']],
    pageSize: { default: 20, max: 100 },
  },
});

/**
 * Twelve rows: three with no time, three of one microsecond, two either side of it within its
 * millisecond, the far ends of the calendar, and two wall times a zone with summer time makes
 * one instant (02:30 on 8 March does not exist in New York; a `timestamptz` reads it as 03:30).
 */
const ROWS: [string, string | null, string | null, string][] = [
  ['a', null, null, 'x'],
  ['b', null, null, 'y'],
  ['c', null, null, 'x'],
  ['d', '2026-01-01 00:00:00.0005+00', '2026-11-01 01:30:00.0005', 'x'],
  ['e', '2026-01-01 00:00:00.0005+00', '2026-11-01 01:30:00.0005', 'y'],
  ['f', '2026-01-01 00:00:00.0005+00', '2026-11-01 01:30:00.0005', 'x'],
  ['g', '2026-01-01 00:00:00.0001+00', '2026-11-01 01:30:00.0001', 'x'],
  ['h', '2026-01-01 00:00:00.0009+00', '2026-11-01 01:30:00.0009', 'x'],
  ['i', '2026-01-01 00:00:00.001+00', '2026-03-08 02:30:00', 'x'],
  ['j', '9999-12-31 00:00:00+00', '2026-03-08 03:30:00', 'x'],
  ['k', '0001-01-01 00:00:00+00', '0001-01-01 00:00:00', 'x'],
  ['l', '2026-01-02 00:00:00+00', '2026-01-02 00:00:00', 'x'],
];

/**
 * The ORDER BY Postgres gives a nullable time: coalesced with a far-off time of the column's own
 * type, midnight UTC for a column with a zone and the bare wall time for one without.
 */
const far = (column: string, dir: 'asc' | 'desc', zoned: boolean) =>
  `coalesce(${column}, '${dir === 'asc' ? '9999-12-31' : '0001-01-01'} 00:00:00${zoned ? '+00' : ''}'::${zoned ? 'timestamptz' : 'timestamp'}) ${dir}`;
const SORTS: [string, string][] = [
  ['seenAt', far('seen_at', 'asc', true)],
  ['-seenAt', far('seen_at', 'desc', true)],
  ['seenAt,title', `${far('seen_at', 'asc', true)}, title asc`],
  ['-seenAt,-title', `${far('seen_at', 'desc', true)}, title desc`],
  ['naiveAt', far('naive_at', 'asc', false)],
  ['-naiveAt', far('naive_at', 'desc', false)],
  ['-naiveAt,title', `${far('naive_at', 'desc', false)}, title asc`],
  ['title,-naiveAt', `title asc, ${far('naive_at', 'desc', false)}`],
  ['naiveText', far('naive_text', 'asc', false)],
  ['-naiveText', far('naive_text', 'desc', false)],
  ['title,-naiveText', `title asc, ${far('naive_text', 'desc', false)}`],
];

describe('a nullable time key, in any session time zone (no server)', () => {
  let pool: ReturnType<typeof createDb>['pool'];
  let client: PoolClient;
  let db: NodePgDatabase;

  beforeAll(async () => {
    pool = createDb(url, { max: 1 }).pool;
    // One connection for the whole describe: the table and the zone are this session's own.
    client = await pool.connect();
    db = drizzle(client);
    await db.execute(
      sql`create temp table keyset_zones (id text primary key, seen_at timestamptz,
        naive_at timestamp, naive_text timestamp, title text not null)`,
    );
    for (const [id, seen, naive, title] of ROWS)
      await client.query('insert into keyset_zones values ($1, $2, $3, $3, $4)', [
        id,
        seen,
        naive,
        title,
      ]);
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  /** Pages through the list builder until there is no next, as `defineEntity`'s list does. */
  async function walk(sort: string, limit: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 60; i++) {
      const q = listQuerySchema(Spec).parse({ sort, limit: String(limit), cursor });
      const built = buildListSql(times, Spec.list, q);
      const where = cursor ? built.after(decodeCursor(cursor, q.sort)) : undefined;
      const found = await db
        .select(built.fields)
        .from(times)
        .where(where ? and(where) : undefined)
        .orderBy(...built.orderBy)
        .limit(limit + 1);
      seen.push(...found.slice(0, limit).map((r) => String(r.row.id)));
      cursor = found.length > limit ? built.cursorAfter(found[limit - 1]) : undefined;
      if (!cursor) return seen;
    }
    return [...seen, 'the walk never ended'];
  }

  for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'America/Sao_Paulo'])
    it(`in ${zone}, every sort at limit 1, 2 and 3 shows each row once, in Postgres's order`, async () => {
      await client.query(`set time zone '${zone}'`);
      const wrong: string[] = [];
      for (const [sort, by] of SORTS) {
        const want = (await client.query(`select id from keyset_zones order by ${by}, id`)).rows
          .map((r: { id: string }) => r.id)
          .join('');
        for (const limit of [1, 2, 3]) {
          const got = (await walk(sort, limit)).join('');
          if (got !== want) wrong.push(`${sort} at limit ${limit}: ${got}, want ${want}`);
        }
      }
      expect(wrong).toEqual([]);
    });
});

describe('a nullable time with a zone, over HTTP', () => {
  const owner = new Person('Owner Keyset Nullable');
  let tenantId = '';
  const BOOKED = [
    null,
    '2026-01-01 00:00:00.0005+00',
    null,
    '2026-01-01 00:00:00.0005+00',
    '2026-01-01 00:00:00.0001+00',
    '2026-01-01 00:00:00.0005+00',
    null,
    '2026-01-01 00:00:00.0009+00',
    '2026-01-02 00:00:00+00',
  ];

  beforeAll(async () => {
    await boot(summaryServer);
    await owner.signUp();
    tenantId = (await me(owner)).tenantId;
    for (let i = 0; i < BOOKED.length; i++) {
      const res = await owner.call('POST', '/api/entries', {
        title: `Entry ${i}`,
        currency: 'EUR',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await appPool.query('update app.fixture_entries set booked_at = $2 where id = $1', [
        res.body.value.id,
        BOOKED[i],
      ]);
    }
  });
  afterAll(shutdown);

  for (const [sort, by] of [
    ['bookedAt', far('booked_at', 'asc', true)],
    ['-bookedAt', far('booked_at', 'desc', true)],
  ])
    for (const limit of [1, 2])
      it(`sort=${sort} at limit=${limit} shows every entry once, the ones with no time last`, async () => {
        const want = (
          await appPool.query(
            `select id from app.fixture_entries where tenant_id = $1 order by ${by}, id`,
            [tenantId],
          )
        ).rows.map((r: { id: string }) => r.id);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 60 && (i === 0 || cursor); i++) {
          const res = await owner.call(
            'GET',
            `/api/entries?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
          );
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          seen.push(...res.body.items.map((e: { id: string }) => e.id));
          cursor = res.body.nextCursor ?? null;
        }
        expect(cursor, 'the walk never ended').toBeNull();
        expect(seen).toEqual(want);
      });
});
