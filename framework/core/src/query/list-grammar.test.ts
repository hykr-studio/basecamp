import { entitySpec, type ListQuery, listInputSchema } from '@hykr/contracts';
import { BadRequestException } from '@nestjs/common';
import { and } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  numeric,
  PgDialect,
  pgEnum,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildListSql, decodeCursor, encodeCursor, listQuery } from './list-grammar.js';

// A fixture entity, so the grammar is tested with no domain: any domain's tables work alike.
const items = pgSchema('app').table('items', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  done: boolean('done').notNull(),
  dueOn: date('due_on'),
});
const Item = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  dueOn: z.iso.date().nullable(),
});
const ItemSpec = entitySpec({
  name: 'item',
  label: 'item',
  description: 'Test items.',
  schemas: { read: Item, create: Item.omit({ id: true }), update: Item.partial() },
  list: {
    filterable: { done: 'boolean', dueOn: 'date', title: 'text' },
    sortable: ['dueOn', 'title'],
    defaultSort: [['dueOn', 'asc']],
    search: ['title'],
    pageSize: { default: 20, max: 100 },
  },
});

const dialect = new PgDialect();
const render = (sql: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(sql);
const parse = (input: object) => listInputSchema(ItemSpec, { maxLimit: 100 }).parse(input);

describe('buildListSql', () => {
  it('turns filters, search and sort into SQL, with id as the last key', () => {
    const q = parse({
      done: false,
      dueOn: { lte: '2026-10-31' },
      q: '50%',
      sort: '-dueOn,title',
      limit: 2,
    });
    const built = buildListSql(items, ItemSpec.list, q);
    const where = render(and(...built.where) as never);
    expect(where.sql).toContain('"done" = $1');
    expect(where.sql).toContain('"due_on" <= $2');
    expect(where.sql).toContain('ilike');
    expect(where.params).toEqual([false, '2026-10-31', '%50\\%%']);
    const order = built.orderBy.map((o) => render(o).sql).join(', ');
    // dueOn is nullable: sorted through coalesce so nulls come last and cursors never skip them.
    expect(order).toBe(
      'coalesce("app"."items"."due_on", $1::date) desc, "app"."items"."title" asc, "app"."items"."id" asc',
    );
    expect(built.limit).toBe(2);
  });

  it('keyset: the cursor clause compares every sort key, then id', () => {
    const q = parse({ sort: 'title' });
    const built = buildListSql(items, ItemSpec.list, q);
    const clause = render(built.after({ s: 'title', v: ['Buy cement'], id: 'abc' }));
    expect(clause.sql).toContain('"title" > $1');
    expect(clause.sql).toContain('"id" > $3');
    expect(clause.params).toEqual(['Buy cement', 'Buy cement', 'abc']);
  });
});

describe('cursors', () => {
  const sort = [{ field: 'dueOn', dir: 'desc' as const }];
  it('round-trips', () => {
    const c = encodeCursor(sort, ['2026-10-01'], 'id-1');
    expect(decodeCursor(c, sort)).toEqual({ s: '-dueOn', v: ['2026-10-01'], id: 'id-1' });
  });
  it('refuses a cursor made for a different sort', () => {
    const c = encodeCursor(sort, ['2026-10-01'], 'id-1');
    expect(() => decodeCursor(c, [{ field: 'title', dir: 'asc' }])).toThrow(BadRequestException);
  });
  it('refuses garbage', () => {
    expect(() => decodeCursor('not-a-cursor', sort)).toThrow(BadRequestException);
  });
});

// A cursor comes back from the client: every value it holds is checked against the column it
// sorts by (docs/decisions/V1.md). A cursor the server made always passes; anything else is 400.
const kinds = pgEnum('cursor_kind', ['a', 'b']);
const every = pgSchema('app').table('cursor_kinds', {
  id: uuid('id').primaryKey(),
  day: date('day').notNull(),
  dayNull: date('day_null'),
  dayDate: date('day_date', { mode: 'date' }).notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  atNull: timestamp('at_null', { withTimezone: true }),
  atText: timestamp('at_text', { withTimezone: true, mode: 'string' }).notNull(),
  atTextNull: timestamp('at_text_null', { withTimezone: true, mode: 'string' }),
  n: integer('n').notNull(),
  nNull: integer('n_null'),
  big: bigint('big', { mode: 'number' }).notNull(),
  amount: numeric('amount').notNull(),
  ratio: doublePrecision('ratio').notNull(),
  title: text('title').notNull(),
  ref: uuid('ref').notNull(),
  kind: kinds('kind').notNull(),
  flag: boolean('flag').notNull(),
});
const ID = '6f1c2a4e-9b3d-4c5e-8f7a-1b2c3d4e5f60';
/** A row as drizzle reads it. */
const row: Record<string, unknown> = {
  id: ID,
  day: '2026-12-01',
  dayNull: null,
  dayDate: new Date('2026-12-01T00:00:00Z'),
  at: new Date('2026-11-12T16:55:48.123Z'),
  atNull: null,
  atText: '2026-11-12 16:55:48.123456+00',
  atTextNull: null,
  n: 3,
  nNull: null,
  big: 9_007_199_254_740_991,
  amount: '12.50',
  ratio: 0.25,
  title: 'Lamp',
  ref: '0b7e9c1a-2d3f-4a5b-9c6d-7e8f9a0b1c2d',
  kind: 'b',
  flag: true,
};
const fields = Object.keys(row).filter((f) => f !== 'id');
const listOf = (sort: ListQuery['sort']): ListQuery => ({
  filters: [],
  sort,
  limit: 10,
  count: false,
});
const config = {
  filterable: {},
  sortable: fields,
  defaultSort: [],
  pageSize: { default: 10, max: 10 },
};
const builtFor = (sort: ListQuery['sort']) => buildListSql(every, config as never, listOf(sort));
/** A cursor carrying exactly these values, as a client could send it. */
const forged = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64url');

function refusal(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return ((e as BadRequestException).getResponse() as { error: string }).error;
  }
  throw new Error('not refused');
}

describe('cursor values', () => {
  it('a cursor the server made passes, for every column type, either way, nulls included', () => {
    for (const field of fields)
      for (const dir of ['asc', 'desc'] as const) {
        const sort = [{ field, dir }];
        const built = builtFor(sort);
        for (const r of [row, { ...row, dayNull: null, atNull: null, nNull: null }]) {
          const cursor = encodeCursor(sort, built.cursorValues(r), String(r.id));
          expect(() => built.after(decodeCursor(cursor, sort)), `${field} ${dir}`).not.toThrow();
        }
      }
  });

  it("a string-mode timestamp's nulls keep a far timestamp, not a number", () => {
    const sort = [{ field: 'atTextNull', dir: 'asc' as const }];
    expect(builtFor(sort).cursorValues(row)).toEqual(['9999-12-31 00:00:00+00']);
    const desc = [{ field: 'atTextNull', dir: 'desc' as const }];
    expect(builtFor(desc).cursorValues(row)).toEqual(['0001-01-01 00:00:00+00']);
  });

  it('a value that does not fit its column is 400 bad_cursor, before any SQL', () => {
    const bad: Record<string, unknown[]> = {
      day: ['not-a-date', '2026-02-31', '2026-12-01T00:00:00Z', { a: 1 }, 123, null, true],
      dayNull: ['not-a-date', [], null],
      dayDate: ['x', '2026-02-31', 1],
      at: ['not-a-date', '2026-02-31T00:00:00.000Z', '2026-11-12', { a: 1 }, 123, null],
      atNull: ['NaN', null],
      atText: ['x', '2026-02-31 00:00:00+00', '2026-11-12 25:00:00+00', 5],
      n: ['3', 1.5, 1e20, null, {}],
      nNull: ['x', Number.NaN],
      big: ['1', 2 ** 60],
      amount: ['abc', '1e5', {}, null],
      ratio: ['x', null, true],
      title: [1, {}, null, ['a']],
      ref: ['not-a-uuid', 7],
      kind: ['c', 1, null],
      flag: ['true', 1, null],
    };
    for (const [field, values] of Object.entries(bad))
      for (const value of values) {
        const sort = [{ field, dir: 'asc' as const }];
        const built = builtFor(sort);
        const cursor = forged({ s: field, v: [value], id: ID });
        expect(
          refusal(() => built.after(decodeCursor(cursor, sort))),
          `${field} ${JSON.stringify(value)}`,
        ).toBe('bad_cursor');
      }
  });

  it('a cursor of the wrong shape is 400 bad_cursor, never a TypeError', () => {
    const sort = [{ field: 'title', dir: 'asc' as const }];
    const built = builtFor(sort);
    for (const body of [
      null,
      5,
      'x',
      [],
      { s: 'title' },
      { s: 'title', v: 'x', id: ID },
      { s: 'title', v: [], id: ID },
      { s: 'title', v: ['a', 'b'], id: ID },
      { s: 'title', v: ['a'] },
      { s: 'title', v: ['a'], id: 5 },
      { s: 'title', v: ['a'], id: 'x'.repeat(201) },
      { s: 'title', v: ['a'], id: 'not-a-uuid' },
      { s: 7, v: ['a'], id: ID },
    ])
      expect(
        refusal(() => built.after(decodeCursor(forged(body), sort))),
        JSON.stringify(body),
      ).toBe('bad_cursor');
  });

  it("Postgres refusing a cursor's value is 400 bad_cursor; without a cursor it stays an error", async () => {
    const pgError = (code: string) =>
      Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('pg'), { code }) });
    await expect(listQuery('c', () => Promise.reject(pgError('22007')))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(listQuery(undefined, () => Promise.reject(pgError('22007')))).rejects.toThrow(
      'Failed query',
    );
    await expect(listQuery('c', () => Promise.reject(pgError('23505')))).rejects.toThrow(
      'Failed query',
    );
    await expect(listQuery('c', () => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('a filter value its column cannot hold (V10)', () => {
  // The list schema takes any number for a `number` field and any text for an `id`: Postgres
  // refused what its column cannot hold (22003, 22P02), a 500, or `bad_cursor` with a cursor.
  const kind = pgEnum('unit_kind', ['a', 'b']);
  const things = pgSchema('app').table('unit_things', {
    id: text('id').primaryKey(),
    rank: integer('rank').notNull(),
    small: smallint('small').notNull(),
    big: bigint('big', { mode: 'number' }).notNull(),
    price: numeric('price', { precision: 6, scale: 2 }).notNull(),
    roomId: uuid('room_id').notNull(),
    kind: kind('kind').notNull(),
  });
  const Thing = z.object({
    id: z.string(),
    rank: z.number(),
    small: z.number(),
    big: z.number(),
    price: z.number(),
    roomId: z.string(),
    kind: z.string(),
  });
  const ThingSpec = entitySpec({
    name: 'unitThing',
    label: 'thing',
    description: 'Things.',
    schemas: { read: Thing, create: Thing.omit({ id: true }), update: Thing.partial() },
    list: {
      filterable: {
        rank: 'number',
        small: 'number',
        big: 'number',
        price: 'number',
        roomId: 'id',
        kind: 'enum',
      },
      sortable: ['rank'],
      defaultSort: [['rank', 'asc']],
      pageSize: { default: 20, max: 100 },
    },
  });
  const build = (input: object) =>
    buildListSql(things, ThingSpec.list, listInputSchema(ThingSpec).parse(input));
  const refused = (input: object) => {
    try {
      build(input);
    } catch (e) {
      return e instanceof BadRequestException ? e.getResponse() : e;
    }
    return undefined;
  };

  it('is 400 invalid, naming the field, before any query', () => {
    for (const input of [
      { rank: 2 ** 31 },
      { rank: { gt: -(2 ** 31) - 1 } },
      { rank: 1.5 },
      { rank: { in: [1, 1e12] } },
      { small: 40_000 },
      { big: 2 ** 53 },
      { price: 10_000 },
      { roomId: 'not-a-uuid' },
      { roomId: { in: ['00000000-0000-4000-8000-000000000000', 'x'] } },
      { kind: 'c' },
    ]) {
      const field = Object.keys(input)[0];
      expect(refused(input), JSON.stringify(input)).toMatchObject({ error: 'invalid', field });
    }
  });

  it('what the column holds builds as before', () => {
    for (const input of [
      { rank: 2 ** 31 - 1 },
      { rank: { in: [-(2 ** 31), 0] } },
      { small: -32_768 },
      { big: Number.MAX_SAFE_INTEGER },
      { price: 9999.99 },
      { roomId: '00000000-0000-4000-8000-000000000000' },
      { kind: { in: ['a', 'b'] } },
    ])
      expect(refused(input), JSON.stringify(input)).toBeUndefined();
  });
});
