// A command's result is projected per entity wherever its output schema reuses an entity's read
// schema, then by the command's own name. Pure: entities are registered, no database.
import { entitySpec, type Principal } from '@hykr/contracts';
import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntity } from '../entity/define-entity.js';
import { entityDef, entityDefForSchema, registerEntityDef } from '../entity/registry.js';
import { entityPlugins, readProjectors } from '../hooks.js';
import { registerOp } from './approvals.js';
import { presentOutput } from './present.js';

const ana: Principal = {
  actor: { kind: 'user', id: 'ana', role: 'owner' },
  subject: { kind: 'user', userId: 'ana' },
  tenantId: 't1',
  roles: ['owner'],
  scopes: [],
};
const staff: Principal = { ...ana, roles: ['staff'] };

const Item = z.object({
  id: z.string(),
  title: z.string(),
  cost: z.number(),
  at: z.iso.datetime(),
});
const ItemSpec = entitySpec({
  name: 'presentItem',
  label: 'item',
  description: 'Items.',
  schemas: { read: Item, create: Item.omit({ id: true }), update: Item.partial() },
  list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 5, max: 5 } },
});
const items = pgSchema('app').table('present_items', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull(),
  cost: text('cost').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
});
const ItemDef = defineEntity(ItemSpec, { table: items, owner: (t) => t.ownerId });
registerEntityDef(ItemDef);

// Cost is stored as text (say, numeric) and read as a number; staff never see it.
entityPlugins.register({
  name: 'unit.cost',
  appliesTo: (spec) => spec.name === 'presentItem',
  toJson: (row) => ({ ...row, cost: Number(row.cost) }),
  project: (read, p) => {
    if (!p.roles?.includes('staff')) return read;
    const { cost: _cost, ...rest } = read;
    return rest;
  },
});
readProjectors.register({
  name: 'unit.note',
  project: (type, value) => {
    if (type !== 'presentItem.bundle') return value;
    const { note: _note, ...rest } = value;
    return rest;
  },
});

const row = {
  id: 'i1',
  tenantId: 't1',
  ownerId: 'ana',
  title: 'Tiles',
  cost: '1200',
  at: new Date(0),
};
const Bundle = z.object({
  main: Item,
  extras: z.array(Item),
  spare: Item.nullable(),
  note: z.string(),
});

describe('presentOutput', () => {
  it('reads and projects each reused entity schema, then the command name', () => {
    const value = { main: row, extras: [row], spare: null, note: 'internal' };
    const seen = { id: 'i1', title: 'Tiles', at: '1970-01-01T00:00:00.000Z' };
    expect(presentOutput(Bundle, value, staff, 'presentItem.bundle')).toEqual({
      main: seen,
      extras: [seen],
      spare: null,
    });
    // The owner sees the cost, as a number, through the plugin's toJson.
    expect(presentOutput(Bundle, value, ana, 'presentItem.bundle')).toMatchObject({
      main: { cost: 1200 },
      extras: [{ cost: 1200 }],
    });
  });

  it('an output that is the read schema itself is that entity', () => {
    expect(presentOutput(Item, row, staff, 'presentItem.touch')).toEqual({
      id: 'i1',
      title: 'Tiles',
      at: '1970-01-01T00:00:00.000Z',
    });
  });

  it('a new schema built from the read schema is not that entity', () => {
    expect(entityDefForSchema(Item.extend({ more: z.string().optional() }))).toBeUndefined();
    expect(entityDefForSchema(Item)).toBe(ItemDef);
  });
});

describe('registries', () => {
  it('an entity is served once, by name and by plural', () => {
    expect(entityDef('presentItem')).toBe(ItemDef);
    // The same definition again (a module's forRoot twice) is a no-op; another one throws.
    expect(() => registerEntityDef(ItemDef)).not.toThrow();
    const other = defineEntity(ItemSpec, { table: items, owner: (t) => t.ownerId });
    expect(() => registerEntityDef(other)).toThrow('The entity "presentItem" is registered twice');
    const twin = defineEntity(
      { ...ItemSpec, name: 'presentTwin' },
      { table: items, owner: (t) => t.ownerId },
    );
    expect(() => registerEntityDef(twin)).toThrow('share the plural "presentItems"');
  });

  it('an operation is registered for replay once, by one definition', () => {
    const owner = {};
    registerOp('presentItem.bundle', () => ({}) as never, owner);
    registerOp('presentItem.bundle', () => ({}) as never, owner);
    expect(() => registerOp('presentItem.bundle', () => ({}) as never)).toThrow(
      'The operation "presentItem.bundle" is registered twice',
    );
    expect(() => registerOp('presentItem.bundle', () => ({}) as never, {})).toThrow(
      'registered twice',
    );
  });
});
