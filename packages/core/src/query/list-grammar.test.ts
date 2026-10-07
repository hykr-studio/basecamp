import { entitySpec, listInputSchema } from '@app/contracts';
import { BadRequestException } from '@nestjs/common';
import { and } from 'drizzle-orm';
import { boolean, date, PgDialect, pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildListSql, decodeCursor, encodeCursor } from './list-grammar.js';

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
