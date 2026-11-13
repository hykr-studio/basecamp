// The settings feature in use (A11): a `gadgets` module whose entity takes custom fields and is
// shared from the platform's business, with a command a platform flag gates; an `extras` module
// a business-managed flag switches off as a whole; a gadgets command that writes an extra
// (the write hook's cross-module case); and one that makes a gadget itself, as any command makes
// records of an entity whose business may require custom fields the command cannot know about.
// Only the settings test's server (`settingsApp`) adds these modules; the other tests never load
// this file.
import { call, defineScript, say, written } from '@hykr/agents/script';
import { defineModule, defineServer } from '@hykr/api';
import {
  CreatedBy,
  CustomFieldsInput,
  CustomFieldValues,
  commandSpec,
  defineFeatureFlag,
  entitySpec,
  moduleSpec,
  SharedFields,
  SharedFromInput,
} from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  defineSharedEntity,
  entityController,
  entityHandlers,
  needsApproval,
  type ReadProjector,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { extras, gadgets } from './schema.js';

const title = z.string().min(1).max(200);

export const Gadget = z.object({
  id: z.string(),
  title,
  rank: z.number().int(),
  custom: CustomFieldValues,
  ...SharedFields,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const GadgetSpec = entitySpec({
  name: 'gadget',
  label: 'gadget',
  description: 'Gadgets: a title and a rank, with the business’s own fields.',
  schemas: {
    read: Gadget,
    create: z.object({
      title,
      rank: z.number().int().optional(),
      custom: CustomFieldsInput.optional(),
      ...SharedFromInput,
    }),
    update: z.object({
      title: title.optional(),
      rank: z.number().int().optional(),
      custom: CustomFieldsInput.optional(),
    }),
  },
  list: {
    filterable: { title: 'text', rank: 'number', custom: 'custom' },
    sortable: ['rank', 'title', 'createdAt'],
    defaultSort: [['rank', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  traits: { customFields: {}, shared: {} },
  // An agent's new gadget waits for the person: its custom values are checked when it parks.
  approval: { create: (p) => p.actor.kind === 'agent' },
});

export const PolishGadgetSpec = commandSpec({
  name: 'gadget.polish',
  description: 'Polish a gadget: its title gets a shine.',
  input: z.object({ gadgetId: z.uuid() }),
  output: Gadget,
  http: { method: 'POST', path: '/api/gadgets/:gadgetId/polish' },
  tool: 'polish-gadget',
  expose: 'all',
  touches: ['gadget'],
});

export const SpawnExtraSpec = commandSpec({
  name: 'gadget.spawnExtra',
  description: 'Make an extra named after a gadget.',
  input: z.object({ gadgetId: z.uuid() }),
  output: z.object({ id: z.string() }),
  http: { method: 'POST', path: '/api/gadgets/:gadgetId/spawn-extra' },
  tool: 'spawn-extra',
  expose: 'all',
  touches: ['extra'],
});

export const CopyGadgetSpec = commandSpec({
  name: 'gadget.copy',
  description: 'Copy a gadget: a new one with its title, and its custom values when asked.',
  input: z.object({ gadgetId: z.uuid(), withCustom: z.boolean().optional() }),
  output: z.object({ id: z.string() }),
  http: { method: 'POST', path: '/api/gadgets/:gadgetId/copy' },
  expose: 'human',
  touches: ['gadget'],
});

export const Extra = z.object({ id: z.string(), title, createdAt: z.iso.datetime() });
export const ExtraSpec = entitySpec({
  name: 'extra',
  label: 'extra',
  description: 'Extras: a title.',
  schemas: {
    read: Extra,
    create: z.object({ title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  // An agent's new extra waits for the person: a parked write in a switched-off module.
  approval: { create: (p) => p.actor.kind === 'agent' },
});

/** Owners their own, admins and ops the whole business. */
const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own' },
};

export const GadgetDef = defineSharedEntity(GadgetSpec, {
  table: gadgets,
  owner: (t) => t.ownerId,
  access: ACCESS,
});

export const ExtraDef = defineEntity(ExtraSpec, {
  table: extras,
  owner: (t) => t.ownerId,
  access: ACCESS,
});

export const PolishGadget = defineCommand(PolishGadgetSpec, {
  resource: { type: 'gadget', id: (input) => input.gadgetId },
  load: (tx, p, input) => GadgetDef.repo.get(tx, p, input.gadgetId),
  authorize: (p) =>
    p.actor.kind === 'agent'
      ? needsApproval('agent_polish', 'Polishing needs approval')
      : allow('owner_polishes'),
  summarize: (_input, gadget) => `Polish ${gadget.title}`,
  run: async ({ tx, principal, loaded: gadget, via }) => {
    const polished = await GadgetDef.repo.update(
      tx,
      principal,
      gadget,
      { title: `${gadget.title} (polished)` },
      via,
    );
    return {
      value: polished,
      touched: [
        { type: 'gadget', id: gadget.id, change: 'updated', before: gadget, after: polished },
      ],
    };
  },
});

export const SpawnExtra = defineCommand(SpawnExtraSpec, {
  resource: { type: 'gadget', id: (input) => input.gadgetId },
  load: (tx, p, input) => GadgetDef.repo.get(tx, p, input.gadgetId),
  authorize: () => allow('owner_spawns'),
  summarize: (_input, gadget) => `Spawn an extra from ${gadget.title}`,
  run: async ({ tx, principal, loaded: gadget, via }) => {
    const extra = await ExtraDef.repo.insert(tx, principal, { title: gadget.title }, via);
    return {
      value: { id: extra.id },
      touched: [{ type: 'extra', id: extra.id, change: 'created', after: extra }],
    };
  },
});

export const CopyGadget = defineCommand(CopyGadgetSpec, {
  resource: { type: 'gadget', id: (input) => input.gadgetId },
  load: (tx, p, input) => GadgetDef.repo.get(tx, p, input.gadgetId),
  authorize: () => allow('owner_copies'),
  summarize: (_input, gadget) => `Copy ${gadget.title}`,
  run: async ({ tx, principal, input, loaded: gadget, via }) => {
    const copy = await GadgetDef.repo.insert(
      tx,
      principal,
      {
        title: `${gadget.title} (copy)`,
        ...(input.withCustom ? { custom: gadget.custom as Record<string, string> } : {}),
      },
      via,
    );
    return {
      value: { id: copy.id },
      touched: [{ type: 'gadget', id: copy.id, change: 'created', after: copy }],
    };
  },
});

@Module({ controllers: [entityController(ExtraDef)], providers: [...entityHandlers(ExtraDef)] })
class ExtrasModule {}

@Module({
  controllers: [
    entityController(GadgetDef),
    commandController(PolishGadget),
    commandController(SpawnExtra),
    commandController(CopyGadget),
  ],
  providers: [
    ...entityHandlers(GadgetDef),
    commandHandler(PolishGadget),
    commandHandler(SpawnExtra),
    commandHandler(CopyGadget),
  ],
})
class GadgetsModule {}

/** Staff never see a gadget's rank, the platform's shared ones included. */
export const staffSeeNoRank: ReadProjector = {
  name: 'fixture.settings.staff-rank',
  project: (type, value, p) => {
    if (type !== 'gadget' || !p.roles?.includes('staff')) return value;
    const { rank: _hidden, ...rest } = value;
    return rest;
  },
};

/** Switches the whole extras module; the business switches it itself. */
export const ExtrasFlag = defineFeatureFlag({
  key: 'extras.all',
  label: { en: 'Extras', hi: 'एक्स्ट्रा', te: 'ఎక్స్‌ట్రాలు' },
  managedBy: 'tenant',
  gates: { modules: ['extras'], nav: ['/extras'] },
});

/** Switches polishing; only the platform switches it. */
export const PolishFlag = defineFeatureFlag({
  key: 'gadgets.polish',
  label: { en: 'Polishing', hi: 'पॉलिश', te: 'పాలిష్' },
  gates: { commands: ['gadget.polish'] },
});

const extrasModule = defineModule({
  ...moduleSpec({ name: 'extras', entities: { extras: ExtraSpec }, commands: [] }),
  server: ExtrasModule,
  tables: { extras },
});

const gadgetsModule = defineModule({
  ...moduleSpec({
    name: 'gadgets',
    dependsOn: ['extras'],
    entities: { gadgets: GadgetSpec },
    commands: [PolishGadgetSpec, SpawnExtraSpec, CopyGadgetSpec],
  }),
  server: GadgetsModule,
  tables: { gadgets },
  // Calls the tool whether or not the turn offers it: the scripted model answers for a
  // switched-off one (V7).
  agent: {
    scripts: [
      defineScript({
        name: 'polish-gadget',
        match: (text) => /^polish gadget ([0-9a-f-]{36})$/.exec(text.trim())?.[1],
        step: (gadgetId, turn) => {
          const r = turn.result('polish-gadget');
          if (!r) return [call('polish-gadget', { gadgetId })];
          return [say(written(r, () => 'Polished.', turn))];
        },
      }),
    ],
  },
  contributes: { featureFlags: [ExtrasFlag, PolishFlag], readProjectors: [staffSeeNoRank] },
});

/** The fixture with the settings feature's modules. */
export const settingsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, extrasModule, gadgetsModule],
});
