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

/**
 * A row as `fields` selects it: each time key beside it as Postgres writes it (`exactTime`), for
 * a row with none the far-off time its sort's coalesce gives.
 */
const selectedAs = (
  built: ReturnType<typeof builtFor>,
  r: Record<string, unknown>,
  time = '2026-11-12T16:55:48.123456',
) => ({
  row: r,
  ...Object.fromEntries(
    Object.keys(built.fields)
      .filter((k) => k !== 'row')
      .map((k) => [k, time]),
  ),
});
const keptBy = (sort: ListQuery['sort'], r: Record<string, unknown>) =>
  decodeCursor(builtFor(sort).cursorAfter(selectedAs(builtFor(sort), r)), sort).v;

describe('a time a cursor keeps (V12)', () => {
  // Postgres keeps microseconds, a Date milliseconds: a cursor cut on the Date took its own row
  // again ascending and skipped the rest of its millisecond descending.
  const at = [{ field: 'at', dir: 'asc' as const }];
  const atDesc = [{ field: 'at', dir: 'desc' as const }];
  const TO_CHAR = `at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

  it('a list selects each time key beside its row, as text to the microsecond', () => {
    const fieldsOf = (sort: ListQuery['sort']) => builtFor(sort).fields as Record<string, never>;
    expect(Object.keys(fieldsOf(at))).toEqual(['row', 'key0']);
    expect(render(fieldsOf(at).key0).sql).toBe(`to_char("app"."cursor_kinds"."at" ${TO_CHAR}`);
    // A nullable one through its coalesce: a row with none keeps the far-off time, same form.
    expect(render(fieldsOf([{ field: 'atNull', dir: 'asc' }]).key0).sql).toBe(
      `to_char(coalesce("app"."cursor_kinds"."at_null", $1::timestamptz) ${TO_CHAR}`,
    );
    // Only times: other values, and a string-mode timestamp's text, are exact in the row.
    expect(Object.keys(fieldsOf([{ field: 'title', dir: 'asc' }]))).toEqual(['row']);
    expect(Object.keys(fieldsOf([{ field: 'atText', dir: 'asc' }]))).toEqual(['row']);
    expect(
      Object.keys(
        fieldsOf([
          { field: 'title', dir: 'asc' },
          { field: 'at', dir: 'desc' },
        ]),
      ),
    ).toEqual(['row', 'key1']);
  });

  it('the cursor keeps that text, not the millisecond the row’s Date holds', () => {
    expect(keptBy(at, row)).toEqual(['2026-11-12T16:55:48.123456']);
    expect(keptBy(atDesc, { ...row, at: null })).toEqual(['2026-11-12T16:55:48.123456']);
  });

  it('compares the sort expression with that text, cast in SQL, never through a Date', () => {
    const v = ['2026-11-12T16:55:48.123456'];
    const asc = render(builtFor(at).after({ s: 'at', v, id: ID }));
    expect(asc.sql).toContain('"app"."cursor_kinds"."at" > $1::timestamptz');
    expect(asc.sql).toContain('"app"."cursor_kinds"."at" = $2::timestamptz');
    expect(asc.params.slice(0, 2)).toEqual([`${v[0]}Z`, `${v[0]}Z`]);
    const desc = render(builtFor(atDesc).after({ s: '-at', v, id: ID }));
    expect(desc.sql).toContain('"app"."cursor_kinds"."at" < $1::timestamptz');
    // A time before another key: rows at the very time go on to the next key.
    const two = [
      { field: 'at', dir: 'asc' as const },
      { field: 'title', dir: 'asc' as const },
    ];
    const both = render(builtFor(two).after({ s: 'at,title', v: [v[0], 'Lamp'], id: ID }));
    expect(both.sql).toContain('("app"."cursor_kinds"."at" = $2::timestamptz and');
    expect(both.sql).toContain('"app"."cursor_kinds"."title" > $3');
  });

  it('a cursor made before V12 still builds: descending, it takes its whole millisecond', () => {
    const v = ['2026-11-12T16:55:48.123Z'];
    const asc = render(builtFor(at).after({ s: 'at', v, id: ID }));
    expect(asc.sql).toContain('"app"."cursor_kinds"."at" > $1::timestamptz');
    const desc = render(builtFor(atDesc).after({ s: '-at', v, id: ID }));
    expect(desc.sql).toContain(
      `"app"."cursor_kinds"."at" < $1::timestamptz + interval '1 millisecond'`,
    );
    expect(desc.sql).toContain(
      `("app"."cursor_kinds"."at" >= $2::timestamptz and "app"."cursor_kinds"."at" < $3::timestamptz + interval '1 millisecond')`,
    );
    expect(desc.params.slice(0, 3)).toEqual([v[0], v[0], v[0]]);
  });

  it('a time with no zone is written and compared as one', () => {
    const plain = pgSchema('app').table('plain_times', {
      id: text('id').primaryKey(),
      at: timestamp('at').notNull(),
    });
    const built = buildListSql(plain, { ...config, sortable: ['at'] } as never, listOf(at));
    expect(render((built.fields as Record<string, never>).key0).sql).toBe(
      `to_char("app"."plain_times"."at", 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
    );
    const clause = render(built.after({ s: 'at', v: ['2026-11-12T16:55:48.123456'], id: 'x' }));
    expect(clause.sql).toContain('"app"."plain_times"."at" > $1::timestamp');
  });
});

describe('cursor values', () => {
  it('a cursor the server made passes, for every column type, either way, nulls included', () => {
    for (const field of fields)
      for (const dir of ['asc', 'desc'] as const) {
        const sort = [{ field, dir }];
        const built = builtFor(sort);
        for (const r of [row, { ...row, dayNull: null, atNull: null, nNull: null }])
          for (const time of [
            '2026-11-12T16:55:48.123456',
            '9999-12-31T00:00:00.000000',
            '0001-01-01T00:00:00.000000',
          ]) {
            const cursor = built.cursorAfter(selectedAs(built, r, time));
            expect(() => built.after(decodeCursor(cursor, sort)), `${field} ${dir}`).not.toThrow();
          }
      }
  });

  it("a string-mode timestamp's nulls keep a far timestamp, not a number", () => {
    const sort = [{ field: 'atTextNull', dir: 'asc' as const }];
    expect(keptBy(sort, row)).toEqual(['9999-12-31 00:00:00+00']);
    const desc = [{ field: 'atTextNull', dir: 'desc' as const }];
    expect(keptBy(desc, row)).toEqual(['0001-01-01 00:00:00+00']);
  });

  it('a value that does not fit its column is 400 bad_cursor, before any SQL', () => {
    const bad: Record<string, unknown[]> = {
      day: ['not-a-date', '2026-02-31', '2026-12-01T00:00:00Z', { a: 1 }, 123, null, true],
      dayNull: ['not-a-date', [], null],
      dayDate: ['x', '2026-02-31', 1],
      at: [
        'not-a-date',
        '2026-02-31T00:00:00.000Z',
        '2026-11-12',
        { a: 1 },
        123,
        null,
        // What `exactTime` writes, tampered: seven digits, no such day or hour, the year 0000
        // (Postgres has no room for it), and forms no server wrote.
        '2026-11-12T16:55:48.1234567',
        '2026-02-31T00:00:00.000000',
        '2026-11-12T24:00:00.000000',
        '0000-01-01T00:00:00.000000',
        '0000-01-01T00:00:00.000Z',
        '2026-11-12T16:55:48.123456Z',
        '2026-11-12 16:55:48.123456',
        '2026-11-12T16:55:48.12345',
      ],
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
