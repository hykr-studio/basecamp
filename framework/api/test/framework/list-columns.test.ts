// The list builder's column checks (`unfit` in @hykr/core's list-grammar.ts) against Postgres
// itself, on a temporary table and no server (docs/decisions/V10.md, decision 22). Each filter
// value the builder lets through, Postgres compares; each it refuses with 400 `invalid`, Postgres
// refuses too, reading it as the column's type (a 22xxx data exception, which was a 500). A table
// written from belief was wrong both ways once: `price=10000` on a numeric(6,2) was refused, and
// Postgres answers it; `ratio[lt]=1e300` on a `real` went through, and Postgres refused it.
import { entitySpec, listInputSchema } from '@hykr/contracts';
import { buildListSql } from '@hykr/core';
import { createDb } from '@hykr/db';
import { BadRequestException } from '@nestjs/common';
import { and, type SQL, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  bigint,
  date,
  doublePrecision,
  integer,
  numeric,
  type PgColumn,
  pgSchema,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';

const url = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';
const temp = pgSchema('pg_temp');
const kind = temp.enum('list_columns_kind', ['a', 'b']);
const things = temp.table('list_columns', {
  id: text('id').primaryKey(),
  small: smallint('small').notNull(),
  rank: integer('rank').notNull(),
  big: bigint('big', { mode: 'number' }).notNull(),
  wide: bigint('wide', { mode: 'bigint' }).notNull(),
  price: numeric('price', { precision: 6, scale: 2 }).notNull(),
  amount: numeric('amount').notNull(),
  ratio: real('ratio').notNull(),
  score: doublePrecision('score').notNull(),
  roomId: uuid('room_id').notNull(),
  kind: kind('kind').notNull(),
  /** An id kept as a number elsewhere, filtered as an `id`: a string on an integer column. */
  seq: integer('seq').notNull(),
  /** A `date` filter reaches a date column as text, and a timestamptz column as a Date. */
  due: date('due').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
});
const NUMBERS = ['small', 'rank', 'big', 'wide', 'price', 'amount', 'ratio', 'score'] as const;
const Thing = z.object({
  id: z.string(),
  ...Object.fromEntries(NUMBERS.map((n) => [n, z.number()])),
  roomId: z.string(),
  kind: z.string(),
  seq: z.string(),
  due: z.string(),
  at: z.string(),
});
const Spec = entitySpec({
  name: 'listColumnsThing',
  label: 'thing',
  description: 'Things with a column of each type.',
  schemas: { read: Thing, create: Thing.omit({ id: true }), update: Thing.partial() },
  list: {
    filterable: {
      ...Object.fromEntries(NUMBERS.map((n) => [n, 'number' as const])),
      roomId: 'id',
      seq: 'id',
      kind: 'enum',
      due: 'date',
      at: 'date',
    },
    sortable: ['rank'],
    defaultSort: [['rank', 'asc']],
    pageSize: { default: 20, max: 100 },
  },
});

// Each end of each type, and either side of it, as a query string's number can say it.
const numbers = [
  0,
  1,
  -1,
  1.5,
  12.5,
  9999.99,
  10_000,
  1e12,
  32_767,
  32_768,
  -32_768,
  -32_769,
  2 ** 31 - 1,
  2 ** 31,
  -(2 ** 31),
  -(2 ** 31) - 1,
  2 ** 53,
  1e16,
  2 ** 63 - 1024,
  2 ** 63,
  -(2 ** 63) + 1024,
  -(2 ** 63),
  1e19,
  3.4e38,
  -3.4e38,
  3.403e38,
  3.5e38,
  1e300,
  -1e300,
  Number.MAX_VALUE,
  1e-38,
  1e-45,
  -1e-45,
  7.1e-46,
  7e-46,
  1e-50,
  5e-324,
];
const ids = [
  '00000000-0000-4000-8000-000000000000',
  'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
  'a0eebc999c0b4ef8bb6d6bb9bd380a11',
  '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}',
  '{a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11}',
  'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11',
  '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}',
  'a0eebc9-99c0b-4ef8-bb6d-6bb9bd380a11',
  'a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11-',
  '-a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  ' a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11a',
  'g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'not-a-uuid',
];

let pool: ReturnType<typeof createDb>['pool'];
let client: PoolClient;
let db: NodePgDatabase;

beforeAll(async () => {
  pool = createDb(url, { max: 1 }).pool;
  // One connection for the whole file: the table is this session's own.
  client = await pool.connect();
  db = drizzle(client);
  await db.execute(sql`create type pg_temp.list_columns_kind as enum ('a', 'b')`);
  await db.execute(
    sql`create temp table list_columns (id text primary key, small smallint not null,
      rank integer not null, big bigint not null, wide bigint not null,
      price numeric(6,2) not null, amount numeric not null, ratio real not null,
      score double precision not null, room_id uuid not null, kind pg_temp.list_columns_kind not null,
      seq integer not null, due date not null, at timestamptz not null)`,
  );
  await db.execute(
    sql`insert into list_columns values ('t', 1, 1, 1, 1, 12.50, 12.5, 0.5, 0.5,
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a', 5, '2026-01-01', '2026-01-01T00:00:00Z')`,
  );
});

afterAll(async () => {
  client?.release();
  await pool?.end();
});

/** Postgres's SQLSTATE for this comparison, or null when it answers. */
async function postgresOn(where: SQL): Promise<string | null> {
  try {
    await db.select({ id: things.id }).from(things).where(where);
    return null;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? 'unknown';
  }
}

/** The comparison the builder makes, by hand and unchecked: `= v`, `< v` or `in (…)`. */
function byHand(column: PgColumn, value: unknown): SQL {
  if (typeof value !== 'object' || value === null) return sql`${column} = ${value}`;
  const [[op, v]] = Object.entries(value);
  if (op === 'in')
    return sql`${column} in (${sql.join(
      (v as unknown[]).map((x) => sql`${x}`),
      sql`, `,
    )})`;
  if (op === 'lt') return sql`${column} < ${v}`;
  throw new Error(`No comparison by hand for ${op}`);
}

/**
 * What the builder and Postgres each make of `field = value`, when they differ. A refusal is the
 * builder's 400 `invalid`, or the field type's schema refusing the value (a date in the year 0000).
 */
async function disagreement(field: string, value: unknown): Promise<string | null> {
  let built: ReturnType<typeof buildListSql> | undefined;
  try {
    built = buildListSql(things, Spec.list, listInputSchema(Spec).parse({ [field]: value }));
  } catch (e) {
    if (e instanceof ZodError) expect(e.issues[0]?.path[0], JSON.stringify(e.issues)).toBe(field);
    else if (e instanceof BadRequestException)
      expect(e.getResponse()).toMatchObject({ error: 'invalid', field });
    else throw e;
  }
  const column = things[field as keyof typeof things.$inferSelect] as PgColumn;
  // Refused: the same comparison, built by hand without the check, is what Postgres refuses.
  const code = await postgresOn(built ? (and(...built.where) as SQL) : byHand(column, value));
  if (code && !code.startsWith('22')) throw new Error(`${field}: Postgres said ${code}`);
  const said = `${field}=${JSON.stringify(value)}`;
  if (!built && !code) return `${said}: refused, and Postgres answers it`;
  if (built && code) return `${said}: built, and Postgres refuses it (${code})`;
  return null;
}

describe('a filter value its column cannot hold, against Postgres (V10)', () => {
  it('the builder refuses exactly what each number column refuses', async () => {
    const wrong: string[] = [];
    for (const field of NUMBERS)
      for (const n of numbers) {
        const w = await disagreement(field, n);
        if (w) wrong.push(w);
      }
    expect(wrong).toEqual([]);
  });

  it('a uuid column: every form Postgres reads, and nothing else', async () => {
    const wrong: string[] = [];
    for (const id of ids) {
      const w = await disagreement('roomId', id);
      if (w) wrong.push(w);
    }
    expect(wrong).toEqual([]);
  });

  it("an enum column: only the type's values", async () => {
    const wrong: string[] = [];
    for (const v of ['a', 'b', 'c', 'A', 'a ']) {
      const w = await disagreement('kind', v);
      if (w) wrong.push(w);
    }
    expect(wrong).toEqual([]);
  });

  it('a string on a number column is left to Postgres, never refused by the builder', async () => {
    // The number checks judge numbers only. Postgres's integer input takes ' 5', '+5' and '05'
    // (and, from 16, '1_000' and '0x10'), so a string is its to read: one it cannot read is
    // the backstop's, as it was before V10.
    const wrong: string[] = [];
    for (const v of ['5', ' 5', '+5', '05', '5 ', '1.5', 'x', '99999999999']) {
      const w = await disagreement('seq', v);
      if (w?.includes('refused, and Postgres answers')) wrong.push(w);
    }
    expect(wrong).toEqual([]);
  });

  it('a list of values is refused for the one its column cannot hold', async () => {
    expect(await disagreement('price', { in: [12.5, 1e12] })).toBeNull();
    expect(await disagreement('rank', { in: [1, 1e12] })).toBeNull();
    expect(await disagreement('ratio', { lt: 1e300 })).toBeNull();
  });

  it('a date filter: what its schema takes, a date and a timestamptz column both read', async () => {
    // The schema judges the instant in UTC (decision 19), but a date column gets the text's day
    // and a `PgDate` or `PgTimestampString` column the text itself: '0000-12-31T23:30:00-01:00'
    // is UTC 0001-01-01 and the text year 0000, which Postgres refuses (22008) as a date and as
    // a timestamptz. Found by the fourth review; the schema refuses the text year 0000 now.
    const wrong: string[] = [];
    for (const field of ['due', 'at'])
      for (const v of [
        '2026-01-01',
        '2026-01-01T23:30:00-01:00',
        '0001-01-01T00:00:00Z',
        '9999-12-31T23:59:59+01:00',
        '0000-01-01',
        '0000-01-01T00:00:00Z',
        '0000-12-31T23:30:00-01:00',
      ]) {
        const w = await disagreement(field, { lt: v });
        if (w) wrong.push(w);
      }
    expect(wrong).toEqual([]);
  });
});
