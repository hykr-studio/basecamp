// References on records with a parent (R1), on neutral data: a `sheets` module whose sheets hold
// a tree of lines, each naming a price item (`itemId`, keyed NO ACTION) and maybe a second one
// (`altItemId`, keyed SET NULL by sql/post). Both are declared with a label: a line reads
// `references: { itemId: { id, label } }`, the item's name and, for the second, its cost, which
// only owners read (field policy). Staff read and write their own items and sheets; owners and
// admins all of the business's. `sheet.save` writes the whole tree (`children.replace`) and
// refuses a bad reference before it could park (`children.checkReferences` in its load); the
// assistant's saves wait for the person. `sheet.add` adds lines (`children.insert`); `sheet.revise`
// makes the next revision, its lines copied, and may replace them. A person's save can be undone
// for a minute. The price items' `find` and `findMany` are counted (`itemQueries`), so a test sees
// how many reference queries a write made. Only the child-references test boots this server.
import { defineModule, defineServer } from '@hykr/api';
import {
  buildTree,
  CreatedBy,
  commandSpec,
  defineApprovalLevel,
  defineCapability,
  entitySpec,
  moduleSpec,
  type TreeNode,
} from '@hykr/contracts';
import {
  allow,
  atLevel,
  type ChildNode,
  commandController,
  commandHandler,
  defineChildEntity,
  defineCommand,
  defineEntity,
  defineLevelRule,
  entityController,
  entityHandlers,
  needsApproval,
  reviseWithChildren,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { priceItems, sheetLines, sheets } from './schema.js';

const same = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);

/** Reads a price item's cost. */
export const ItemCost = defineCapability({
  name: 'fixture.sheets.cost',
  label: same('Price item costs'),
  roles: ['owner'],
});

export const PriceItemSpec = entitySpec({
  name: 'priceItem',
  label: 'price item',
  description: 'Price items: a name and a cost.',
  schemas: {
    read: z.object({
      id: z.string(),
      name: title,
      // Optional: removed for whoever may not read it.
      cost: z.number().int().nullable().optional(),
      createdBy: CreatedBy,
      createdAt: z.iso.datetime(),
    }),
    create: z.object({ name: title, cost: z.number().int().min(0).nullable().optional() }),
    update: z.object({
      name: title.optional(),
      cost: z.number().int().min(0).nullable().optional(),
    }),
  },
  list: {
    filterable: { name: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: { fieldPolicy: { cost: ItemCost.name } },
});

export const Sheet = z.object({
  id: z.string(),
  title,
  version: z.number().int(),
  seriesId: z.string().nullable(),
  revision: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const SheetSpec = entitySpec({
  name: 'sheet',
  label: 'sheet',
  description: 'Sheets: a title and a tree of lines, in revisions.',
  schemas: {
    read: Sheet,
    create: z.object({ title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: { versioned: { revisions: {} } },
});

export const SheetLine = z.object({
  id: z.string(),
  sheetId: z.string(),
  parentLineId: z.string().nullable(),
  position: z.number().int(),
  title,
  itemId: z.string().nullable(),
  altItemId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

const lineFields = {
  title,
  itemId: z.uuid().nullable().optional(),
  altItemId: z.uuid().nullable().optional(),
};

export const SheetLineSpec = entitySpec({
  name: 'sheetLine',
  label: 'sheet line',
  description: 'The lines of a sheet, in a tree, each naming a price item.',
  schemas: {
    read: SheetLine,
    create: z.object(lineFields),
    update: z.object({
      ...lineFields,
      title: title.optional(),
      parentLineId: z.string().nullable().optional(),
      position: z.number().int().min(0).optional(),
      sheetId: z.string().optional(),
    }),
  },
  list: {
    filterable: { sheetId: 'id' },
    sortable: ['position', 'createdAt'],
    defaultSort: [['position', 'asc']],
    pageSize: { default: 100, max: 1000 },
  },
  traits: {
    parent: {
      entity: 'sheet',
      field: 'sheetId',
      nest: 'parentLineId',
      position: 'position',
      maxNodes: 1200,
    },
    references: {
      itemId: { entity: 'priceItem', label: 'name' },
      altItemId: { entity: 'priceItem', label: 'cost' },
    },
  },
});

/** A sheet's tree as a save sends it: flat, each line naming the line above by its ref. */
export const SaveLineInput = z.object({
  ref: z.string().min(1).max(40),
  parent: z.string().min(1).max(40).optional(),
  id: z.uuid().optional(),
  title,
  itemId: z.uuid().nullable().optional(),
  altItemId: z.uuid().nullable().optional(),
});

export const SaveSheetSpec = commandSpec({
  name: 'sheet.save',
  description: 'Save a whole sheet: its title and every line, in one go.',
  input: z.object({
    sheetId: z.uuid().optional(),
    title,
    items: z.array(SaveLineInput).max(1200),
  }),
  output: z.object({ sheet: Sheet, items: z.array(SheetLine) }),
  http: { method: 'POST', path: '/api/sheets/save' },
  tool: 'save-sheet',
  expose: 'all',
  touches: ['sheet', 'sheetLine'],
});

const NewLineInput = z.object({
  title,
  itemId: z.uuid().nullable().optional(),
  altItemId: z.uuid().nullable().optional(),
});

export const AddLinesSpec = commandSpec({
  name: 'sheet.add',
  description: 'Add lines at the end of a sheet.',
  input: z.object({ sheetId: z.uuid(), items: z.array(NewLineInput).max(1200) }),
  output: z.object({ items: z.array(SheetLine) }),
  http: { method: 'POST', path: '/api/sheets/:sheetId/lines' },
  expose: 'all',
  touches: ['sheetLine'],
});

export const ReviseSheetSpec = commandSpec({
  name: 'sheet.revise',
  description: 'Make the next revision of a sheet, its lines copied or replaced by new ones.',
  input: z.object({ sheetId: z.uuid(), items: z.array(NewLineInput).max(1200).optional() }),
  output: z.object({ sheet: Sheet, items: z.array(SheetLine) }),
  http: { method: 'POST', path: '/api/sheets/:sheetId/revise' },
  expose: 'all',
  touches: ['sheet', 'sheetLine'],
});

const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

/** How many times the price items were loaded by id, one by one or many at once. */
export const itemQueries = { find: 0, findMany: 0 };

export const PriceItemDef = defineEntity(PriceItemSpec, {
  table: priceItems,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});
{
  const { find, findMany } = PriceItemDef.repo;
  PriceItemDef.repo.find = (...a) => {
    itemQueries.find++;
    return find(...a);
  };
  PriceItemDef.repo.findMany = (...a) => {
    itemQueries.findMany++;
    return findMany(...a);
  };
}

export const SheetDef = defineEntity(SheetSpec, {
  table: sheets,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

export const SheetLineDef = defineChildEntity(SheetLineSpec, {
  table: sheetLines,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  parent: { def: SheetDef, owner: (t) => t.ownerId, customer: (t) => t.customerId },
});

type SaveLine = z.infer<typeof SaveLineInput>;

/** The flat lines as a tree of child nodes, each keeping its ref (a refusal names it). */
const toNodes = (items: readonly SaveLine[]): ChildNode[] => {
  const toNode = (n: TreeNode<SaveLine>): ChildNode => {
    const { parent: _parent, children, ...fields } = n;
    return { ...fields, children: children.map(toNode) };
  };
  return buildTree(items, { key: 'ref', parent: 'parent' }).map(toNode);
};

export const SaveSheet = defineCommand(SaveSheetSpec, {
  resource: { type: 'sheet', id: (input) => input.sheetId ?? null },
  // Loaded before it is authorized: a line naming an item the person cannot read is refused here,
  // so the assistant's save that would wait is refused before it reaches the person.
  load: async (tx, p, input) => {
    const sheet = input.sheetId ? await SheetDef.repo.get(tx, p, input.sheetId) : null;
    await SheetLineDef.children.checkReferences(tx, p, toNodes(input.items), {
      at: ['items'],
      ...(sheet ? { parent: sheet } : {}),
    });
    return sheet;
  },
  authorize: (p) =>
    p.actor.kind === 'agent'
      ? needsApproval('agent_saves', 'Sheets the assistant saves need approval')
      : allow('person_saves'),
  summarize: (input) => `Save ${input.title} with ${input.items.length} lines`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const sheet = loaded
      ? await SheetDef.repo.update(tx, principal, loaded, { title: input.title }, via)
      : await SheetDef.repo.insert(tx, principal, { title: input.title }, via);
    const lines = await SheetLineDef.children.replace(
      tx,
      principal,
      sheet,
      toNodes(input.items),
      via,
      { at: ['items'] },
    );
    return {
      value: {
        sheet: SheetDef.toRead(sheet, principal),
        items: lines.rows.map((r) => SheetLineDef.toRead(r, principal)),
      },
      touched: [
        {
          type: 'sheet',
          id: sheet.id,
          change: loaded ? 'updated' : 'created',
          before: loaded ?? undefined,
          after: sheet,
        },
        ...lines.touched,
      ],
    };
  },
});

export const AddLines = defineCommand(AddLinesSpec, {
  resource: { type: 'sheet', id: (input) => input.sheetId },
  load: (tx, p, input) => SheetDef.repo.get(tx, p, input.sheetId),
  authorize: () => allow('add_lines'),
  summarize: (input) => `Add ${input.items.length} lines`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const lines = await SheetLineDef.children.insert(tx, principal, loaded, input.items, via, {
      at: ['items'],
    });
    return {
      value: { items: lines.created.map((r) => SheetLineDef.toRead(r, principal)) },
      touched: lines.touched,
    };
  },
});

export const ReviseSheet = defineCommand(ReviseSheetSpec, {
  resource: { type: 'sheet', id: (input) => input.sheetId },
  load: (tx, p, input) => SheetDef.repo.get(tx, p, input.sheetId),
  authorize: () => allow('revise'),
  summarize: (_input, sheet) => `Revise "${sheet.title}" (v${sheet.revision})`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const next = await reviseWithChildren(tx, principal, SheetDef, loaded, { via });
    const row = next.row as typeof loaded;
    let items = (next.children.sheetLine ?? []) as (typeof sheetLines.$inferSelect)[];
    const touched = [...next.touched];
    if (input.items) {
      const lines = await SheetLineDef.children.replace(tx, principal, row, input.items, via, {
        at: ['items'],
      });
      items = lines.rows;
      // The copies the replace deleted were created by this same write: list each change once.
      const gone = new Set(lines.deleted.map((r) => r.id));
      for (const t of lines.touched) if (t.change !== 'deleted') touched.push(t);
      for (let i = touched.length - 1; i >= 0; i--)
        if (touched[i].type === 'sheetLine' && gone.has(touched[i].id)) touched.splice(i, 1);
    }
    return {
      value: {
        sheet: SheetDef.toRead(row, principal),
        items: items.map((r) => SheetLineDef.toRead(r, principal)),
      },
      touched,
    };
  },
});

@Module({
  controllers: [
    entityController(PriceItemDef),
    entityController(SheetDef),
    entityController(SheetLineDef),
    commandController(SaveSheet),
    commandController(AddLines),
    commandController(ReviseSheet),
  ],
  providers: [
    ...entityHandlers(PriceItemDef),
    ...entityHandlers(SheetDef),
    ...entityHandlers(SheetLineDef),
    commandHandler(SaveSheet),
    commandHandler(AddLines),
    commandHandler(ReviseSheet),
  ],
})
class SheetsModule {}

export const sheetsModule = defineModule({
  ...moduleSpec({
    name: 'sheets',
    entities: { priceItems: PriceItemSpec, sheets: SheetSpec, sheetLines: SheetLineSpec },
    commands: [SaveSheetSpec, AddLinesSpec, ReviseSheetSpec],
  }),
  server: SheetsModule,
  tables: { priceItems, sheets, sheetLines },
});

/** A person's save runs, and can be undone for a minute. */
export const UndoableSave = defineApprovalLevel({
  name: 'fixture_sheets_undoable',
  rank: 1,
  label: same('Undoable'),
  policy: { parks: false, undoMs: 60_000 },
});

export const SaveLevels = defineLevelRule({
  name: 'fixture.sheets',
  on: ['sheet.save'],
  decide: () => atLevel(UndoableSave.name, 'sheet_undoable', 'It can be undone'),
});

/** The fixture with the sheets module. */
export const childReferencesServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, sheetsModule],
  contributes: {
    capabilities: [ItemCost],
    approvalLevels: [UndoableSave],
    levelRules: [SaveLevels],
  },
});
