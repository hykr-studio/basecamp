// The imports feature in use (B20): a `shelves` module with shelves and items an import fills.
// - A bin's spec opts out of imports (`traits.imports: false`).
// - An item names its shelf (`shelfId`): an import gives the shelf's key with `refs`.
// - An item's `cost` is read and written only with `fixture.items.cost` (owners).
// - An item's `done` is in its update schema only: an import sets it after the create.
// - A title starting with "Refused" is refused by a rule; one starting with "Wait" waits for an
//   approval (a plain CRUD write parks).
// - A business's `fixture_importer` role may import (`imports.run`); its imports wait for
//   someone with `approvals.decide` (a level rule on `import.start`). Owners and admins import
//   at once.
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  defineCapability,
  defineRole,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import {
  defineEntity,
  defineLevelRule,
  deny,
  entityController,
  entityHandlers,
  needsApproval,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { bins, items, shelves } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);

/** Reads and writes an item's cost. */
export const ItemCost = defineCapability({
  name: 'fixture.items.cost',
  label: label('Item costs'),
  roles: ['owner'],
});

/** A business's people who import: they reach their own items and may import. */
export const Importer = defineRole({
  name: 'fixture_importer',
  label: label('Importer'),
  capabilities: ['imports.run'],
});

/** Owners and admins every row; staff and importers their own. */
const ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'own',
    fixture_importer: 'own',
    customer: 'customer',
  },
  write: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'own',
    fixture_importer: 'own',
    customer: 'customer',
  },
};

export const ShelfSpec = entitySpec({
  name: 'shelf',
  label: 'shelf',
  plural: 'shelves',
  description: 'Shelves: a title.',
  schemas: {
    read: z.object({
      id: z.string(),
      title,
      createdBy: CreatedBy,
      createdAt: z.iso.datetime(),
    }),
    create: z.object({ title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 200 },
  },
});

export const ItemSpec = entitySpec({
  name: 'item',
  label: 'item',
  description: 'Items: a title, a quantity, the shelf they are on, tags and a cost.',
  schemas: {
    read: z.object({
      id: z.string(),
      title,
      shelfId: z.string().nullable(),
      qty: z.number().int(),
      // Optional: removed for whoever may not read it.
      cost: z.number().int().nullable().optional(),
      done: z.boolean(),
      tags: z.array(z.string()).nullable(),
      createdBy: CreatedBy,
      createdAt: z.iso.datetime(),
    }),
    create: z.object({
      title,
      shelfId: z.uuid().nullable().optional(),
      qty: z.number().int().min(0).optional(),
      cost: z.number().int().min(0).nullable().optional(),
      tags: z.array(z.string().max(40)).max(10).nullable().optional(),
    }),
    update: z.object({
      title: title.optional(),
      shelfId: z.uuid().nullable().optional(),
      qty: z.number().int().min(0).optional(),
      cost: z.number().int().min(0).nullable().optional(),
      done: z.boolean().optional(),
      tags: z.array(z.string().max(40)).max(10).nullable().optional(),
    }),
  },
  list: {
    filterable: { title: 'text', shelfId: 'id', done: 'boolean' },
    sortable: ['createdAt', 'title'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 200 },
  },
  traits: { fieldPolicy: { cost: ItemCost.name } },
});

/** Bins: their spec opts out of imports. */
export const BinSpec = entitySpec({
  name: 'bin',
  label: 'bin',
  description: 'Bins: a title. Never imported from a file.',
  schemas: {
    read: z.object({ id: z.string(), title, createdBy: CreatedBy, createdAt: z.iso.datetime() }),
    create: z.object({ title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: {},
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 200 },
  },
  traits: { imports: false },
});

/** A rule on titles: "Refused…" is refused, "Wait…" waits for an approval. */
const titleRule = (
  _p: unknown,
  action: string,
  _row: unknown,
  input: Record<string, unknown> | null,
) => {
  if (action === 'delete' || typeof input?.title !== 'string') return null;
  if (input.title.startsWith('Refused'))
    return deny('fixture.items.refused', 'Titles starting with Refused are refused');
  if (input.title.startsWith('Wait'))
    return needsApproval('fixture.items.wait', 'Titles starting with Wait wait for approval');
  return null;
};

export const ShelfDef = defineEntity(ShelfSpec, {
  table: shelves,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

export const BinDef = defineEntity(BinSpec, {
  table: bins,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

export const ItemDef = defineEntity(ItemSpec, {
  table: items,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  rules: [titleRule],
});

@Module({
  controllers: [entityController(ShelfDef), entityController(ItemDef), entityController(BinDef)],
  providers: [...entityHandlers(ShelfDef), ...entityHandlers(ItemDef), ...entityHandlers(BinDef)],
})
export class ShelvesModule {}

export const shelvesModule = defineModule({
  ...moduleSpec({
    name: 'shelves',
    dependsOn: [],
    entities: { shelves: ShelfSpec, items: ItemSpec, bins: BinSpec },
    commands: [],
  }),
  server: ShelvesModule,
  tables: { shelves, items, bins },
});

/** An importer's imports wait for someone who decides approvals; owners and admins do not. */
export const importsWait = defineLevelRule({
  name: 'fixture.imports.wait',
  on: ['import.start'],
  decide: ({ p }) =>
    p.roles?.includes(Importer.name)
      ? needsApproval('fixture.imports_wait', 'Imports wait for someone who decides approvals', {
          approver: { by: { capability: 'approvals.decide' } },
        })
      : null,
});

export const importsContributions: Partial<Contributions> = {
  capabilities: [ItemCost],
  roles: [Importer],
  levelRules: [importsWait],
};

/** The fixture plus shelves and items. */
export const importsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, shelvesModule],
  contributes: importsContributions,
});
