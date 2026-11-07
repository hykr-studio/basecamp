// The summary grammar and the list scope a summary runs under, with no domain and no database:
// the scope is read from the entity's own list query, recorded instead of sent.
import {
  entitySpec,
  Money,
  type Principal,
  summarizable,
  summaryInputSchema,
  summaryQuerySchema,
} from '@hykr/contracts';
import { currencyColumn, minorUnits } from '@hykr/db';
import { boolean, date, integer, PgDialect, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntity } from '../entity/define-entity.js';
import { listWhere } from './aggregate.js';

const rows = pgSchema('app').table('summary_rows', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull(),
  state: text('state', { enum: ['open', 'shut'] }).notNull(),
  flagged: boolean('flagged').notNull(),
  currency: currencyColumn(),
  total: minorUnits('total').notNull(),
  units: integer('units').notNull(),
  bookedAt: timestamp('booked_at', { withTimezone: true }),
  dueOn: date('due_on'),
});
const Row = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(['open', 'shut']),
  flagged: z.boolean(),
  currency: z.string(),
  total: Money,
  units: z.number(),
  bookedAt: z.string().nullable(),
  dueOn: z.string().nullable(),
});
const RowSpec = entitySpec({
  name: 'summaryRow',
  label: 'row',
  description: 'Rows.',
  schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
  list: {
    filterable: {
      state: 'enum',
      flagged: 'boolean',
      title: 'text',
      total: 'money',
      units: 'number',
      bookedAt: 'date',
      dueOn: 'date',
    },
    sortable: [],
    defaultSort: [],
    search: ['title'],
    pageSize: { default: 20, max: 100 },
  },
  traits: { money: { fields: ['total'] } },
});

const json = (input: object) => summaryInputSchema(RowSpec).safeParse(input);
const http = (input: object) => summaryQuerySchema(RowSpec).safeParse(input);

describe('what a summary can do with each field', () => {
  it('groups by values and date periods, measures numbers and money', () => {
    expect(summarizable(RowSpec)).toEqual({
      group: [
        { field: 'state', by: 'value' },
        { field: 'flagged', by: 'value' },
        { field: 'title', by: 'value' },
        { field: 'bookedAt', by: 'bucket' },
        { field: 'dueOn', by: 'bucket' },
      ],
      measure: [
        { field: 'total', as: 'money' },
        { field: 'units', as: 'number' },
      ],
    });
  });
});

describe('the summary grammar', () => {
  it('JSON: filters, groups, measures, sort and limit', () => {
    const r = json({
      state: 'open',
      groupBy: ['bookedAt:month', 'flagged'],
      sum: ['total', 'units'],
      avg: 'units',
      sort: '-sum:total',
      limit: 4,
    });
    expect(r.success && r.data).toEqual({
      filters: [{ field: 'state', op: 'eq', value: 'open' }],
      q: undefined,
      groupBy: [{ field: 'bookedAt', bucket: 'month' }, { field: 'flagged' }],
      measures: [
        { fn: 'sum', field: 'total', money: true },
        { fn: 'sum', field: 'units', money: false },
        { fn: 'avg', field: 'units', money: false },
      ],
      sort: { by: 'sum:total', dir: 'desc' },
      limit: 4,
    });
  });

  it('defaults: by key with groups, else by count; 50 groups', () => {
    const grouped = json({ groupBy: 'state' });
    expect(grouped.success && grouped.data).toMatchObject({
      sort: { by: 'key', dir: 'asc' },
      limit: 50,
    });
    const plain = json({});
    expect(plain.success && plain.data).toMatchObject({ groupBy: [], measures: [] });
  });

  it('a query string: comma lists, coerced values, bracket operators', () => {
    const r = http({
      'units[gte]': '2',
      flagged: 'true',
      groupBy: 'state,dueOn:week',
      max: 'units',
      limit: '10',
      q: 'x',
    });
    expect(r.success && r.data).toMatchObject({
      filters: [
        { field: 'flagged', op: 'eq', value: true },
        { field: 'units', op: 'gte', value: 2 },
      ],
      q: 'x',
      groupBy: [{ field: 'state' }, { field: 'dueOn', bucket: 'week' }],
      measures: [{ fn: 'max', field: 'units', money: false }],
      limit: 10,
    });
  });

  it('refuses what it cannot compute', () => {
    for (const bad of [
      { groupBy: ['units'] },
      { groupBy: ['bookedAt'] },
      { groupBy: ['bookedAt:hour'] },
      { groupBy: ['state', 'flagged', 'title'] },
      { groupBy: ['dueOn:month', 'dueOn:year'] },
      { sum: ['state'] },
      { sum: ['total', 'units'], avg: ['total', 'units'], min: ['total', 'units'], max: ['units'] },
      { sort: 'total' },
      { groupBy: 'state', sort: 'sum:units' },
      { limit: 0 },
      { limit: 201 },
      { nope: 1 },
      { units: { contains: 'x' } },
    ])
      expect(json(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('a field named like a summary word is refused when the schema is built', () => {
    const Clash = entitySpec({
      ...RowSpec,
      name: 'clash',
      list: { ...RowSpec.list, filterable: { ...RowSpec.list.filterable, sum: 'number' } },
    });
    expect(() => summaryInputSchema(Clash)).toThrow(/cannot be called "sum"/);
  });
});

describe('the scope a summary runs under', () => {
  const def = defineEntity(RowSpec, { table: rows, owner: (t) => t.ownerId });
  const p = (roles: string[]): Principal => ({
    actor: { kind: 'user', id: 'u1' },
    subject: { kind: 'user', userId: 'u1' },
    tenantId: 't1',
    roles,
    scopes: [],
  });
  const render = (sql: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(sql);

  it('is the list’s own WHERE: the business, the grants, then the filters', async () => {
    const where = render(
      await listWhere(def, p(['owner']), {
        filters: [{ field: 'state', op: 'eq', value: 'open' }],
        q: 'x',
      }),
    );
    expect(where.sql).toContain('"app"."summary_rows"."tenant_id" = $1');
    expect(where.sql).toContain('"app"."summary_rows"."state" = ');
    expect(where.sql).toContain('ilike');
    expect(where.params).toContain('t1');
    expect(where.params).toContain('open');
  });

  it('narrows to the person’s own rows where their grant is own', async () => {
    const where = render(await listWhere(def, p(['staff']), { filters: [] }));
    expect(where.sql).toContain('"app"."summary_rows"."owner_id" = ');
    expect(where.params).toContain('u1');
  });

  it('a principal with no business is refused', async () => {
    await expect(
      listWhere(def, { ...p(['owner']), tenantId: undefined }, { filters: [] }),
    ).rejects.toMatchObject({ response: { rule: 'no_tenant' } });
  });
});
