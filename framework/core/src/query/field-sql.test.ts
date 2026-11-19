// List field types are a registry: a type's grammar (contracts) and its SQL (core) are added
// without touching the list builder. A field of a type nobody defined fails closed.
import { defineListFieldType, entitySpec, listInputSchema } from '@hykr/contracts';
import { and, sql } from 'drizzle-orm';
import { PgDialect, pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listFieldSql } from './field-sql.js';
import { buildListSql } from './list-grammar.js';

declare module '@hykr/contracts' {
  interface ListFieldTypes {
    unitWords: true;
    unitNoSql: true;
  }
  interface ListFilterOps {
    hasWord: true;
  }
}

// A text column searched by whole word, and a point-like object value for its bare form.
defineListFieldType({
  name: 'unitWords',
  ops: ['eq', 'hasWord'],
  value: () => z.string().min(1).max(50),
  opValue: (op) => (op === 'hasWord' ? z.object({ word: z.string().regex(/^\w+$/) }) : undefined),
});
listFieldSql.register({
  name: 'unitWords',
  where: ({ column, op, value }) =>
    op === 'hasWord'
      ? sql`${column} ~* ${`\\m${(value as { word: string }).word}\\M`}`
      : sql`${column} = ${value}`,
});
defineListFieldType({ name: 'unitNoSql', ops: ['eq'], value: () => z.string() });

const rows = pgSchema('app').table('unit_rows', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  code: text('code').notNull(),
});
const Row = z.object({ id: z.string(), title: z.string(), code: z.string() });
const spec = (filterable: Record<string, string>) =>
  entitySpec({
    name: 'unitRow',
    label: 'row',
    description: 'Rows.',
    schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
    list: {
      filterable: filterable as never,
      sortable: ['title'],
      defaultSort: [['title', 'asc']],
      pageSize: { default: 20, max: 100 },
    },
  });
const render = (sql: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(sql);

describe('list field types', () => {
  it('a defined type takes its own operators and value shapes, and builds its own SQL', () => {
    const Spec = spec({ title: 'unitWords' });
    const q = listInputSchema(Spec).parse({ title: { hasWord: { word: 'tiles' } } });
    expect(q.filters).toEqual([{ field: 'title', op: 'hasWord', value: { word: 'tiles' } }]);
    const where = render(and(...buildListSql(rows, Spec.list, q).where) as never);
    expect(where.sql).toBe('"app"."unit_rows"."title" ~* $1');
    expect(where.params).toEqual(['\\mtiles\\M']);
    // A bare value is eq, when the type has it.
    expect(listInputSchema(Spec).parse({ title: 'x' }).filters).toEqual([
      { field: 'title', op: 'eq', value: 'x' },
    ]);
  });

  it("a value or operator outside the type's grammar is refused", () => {
    const Spec = spec({ title: 'unitWords' });
    expect(listInputSchema(Spec).safeParse({ title: { contains: 'x' } }).success).toBe(false);
    expect(listInputSchema(Spec).safeParse({ title: { hasWord: { word: 'a b' } } }).success).toBe(
      false,
    );
  });

  it('a type nobody defined fails when the schema is built', () => {
    expect(() => listInputSchema(spec({ title: 'nope' }))).toThrow(
      'No list field type "nope" is defined',
    );
  });

  it('a type without SQL fails the query instead of filtering nothing', () => {
    const Spec = spec({ code: 'unitNoSql' });
    const q = listInputSchema(Spec).parse({ code: 'A1' });
    expect(() => buildListSql(rows, Spec.list, q)).toThrow(
      'No SQL for list field type "unitNoSql"',
    );
  });

  it('a type is defined once', () => {
    expect(() =>
      defineListFieldType({ name: 'text', ops: ['eq'], value: () => z.string() }),
    ).toThrow('The list field type "text" is registered twice');
    expect(() => listFieldSql.register({ name: 'text', where: () => undefined as never })).toThrow(
      'registered twice',
    );
  });
});
