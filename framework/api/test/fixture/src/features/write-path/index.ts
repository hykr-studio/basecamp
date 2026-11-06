// The core write and read path's extension points in use (F3): an entity plugin with every
// hook, a write hook, a contributed list field type, and a command whose result reuses the
// entity's read schema. The `chore` entity is served over the fixture's tasks table, by a
// `chores` module that only the write-path test's server (`writePath`) adds; the other tests
// never load this file.
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  commandSpec,
  defineListFieldType,
  entitySpec,
  moduleSpec,
  type Principal,
} from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  deny,
  type EntityPlugin,
  entityController,
  entityHandlers,
  type NamedEvent,
  needsApproval,
  type ReadProjector,
  type WriteHook,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { tasks } from '../../schema.js';

declare module '@hykr/contracts' {
  interface EntityTraits {
    /** The fields people with these roles never see. */
    fixtureGuarded?: { hidden: string[]; from: string[] };
  }
  interface ListFieldTypes {
    fixtureWords: true;
  }
  interface ListFilterOps {
    hasWord: true;
  }
}

/** Text matched by whole word: `title[hasWord]=tiles` finds "Order tiles", not "tilesets". */
defineListFieldType({
  name: 'fixtureWords',
  ops: ['eq', 'hasWord'],
  value: () => z.string().max(200),
  opValue: (op) => (op === 'hasWord' ? z.string().regex(/^\w{1,40}$/) : undefined),
});

const title = z.string().min(1).max(200);

export const Chore = z.object({
  id: z.string(),
  title,
  done: z.boolean(),
  dueOn: z.iso.date().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const ChoreSpec = entitySpec({
  name: 'chore',
  label: 'chore',
  description: 'Chores: a title, done or not, and a due date (hidden from staff).',
  schemas: {
    read: Chore,
    create: z.object({ title, dueOn: z.iso.date().optional() }),
    update: z.object({
      title: title.optional(),
      done: z.boolean().optional(),
      dueOn: z.iso.date().nullable().optional(),
    }),
  },
  list: {
    filterable: { title: 'fixtureWords', done: 'boolean' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  approval: { delete: (p) => p.actor.kind === 'agent' },
  traits: { fixtureGuarded: { hidden: ['dueOn'], from: ['staff'] } },
});

const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const ChoreDef = defineEntity(ChoreSpec, {
  table: tasks,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  rules: [
    // An entity's own rule that parks a plain update.
    (_p, action, _row, input) =>
      action === 'update' && String(input?.title ?? '').includes('[ask]')
        ? needsApproval('chore_title_asks', 'A title marked [ask] waits for approval')
        : null,
  ],
});

const guardedOf = (spec: { traits?: { fixtureGuarded?: { hidden: string[]; from: string[] } } }) =>
  spec.traits?.fixtureGuarded;
const hides = (p: Principal, from: string[]) => (p.roles ?? []).some((r) => from.includes(r));

/** One plugin with every hook, switched on by the `fixtureGuarded` trait. */
export const guarded: EntityPlugin = {
  name: 'fixture.guarded',
  appliesTo: (spec) => guardedOf(spec) !== undefined,
  rules: [
    (_p, action, row) =>
      action === 'delete' && String(row?.title ?? '').includes('[keep]')
        ? deny('chore_keep', 'A chore marked [keep] stays')
        : null,
  ],
  decide: (_p, action, _row, input) => {
    if (String(input?.title ?? '').includes('[client]'))
      return needsApproval('chore_client_send', 'Sends to a client wait for an admin', {
        tier: 2,
        approver: { roles: ['admin'] },
      });
    if (action === 'update' && input?.done === true)
      return allow('chore_done_undoable', 'Done can be undone for a minute', {
        tier: 1,
        undoMs: 60_000,
      });
    return null;
  },
  // Archived chores are out of reach, for reading and writing alike.
  scope: () => sql`${tasks.title} not like 'archived:%'`,
  toValues: (values, { action }) => ({
    ...values,
    ...(action === 'create' && values.dueOn === undefined ? { dueOn: '2030-01-01' } : {}),
    // Never honoured: the framework sets the business and the owner after plugins.
    tenantId: 'not-this-business',
    ownerId: 'not-this-owner',
  }),
  toJson: (row) => ({ ...row, title: String(row.title).trim() }),
  // A write from a stale read: the title it saw must still be the title.
  updateWhere: (row) => eq(tasks.title, String(row.title)),
  project: (read, p, { spec }) => {
    const rule = guardedOf(spec);
    if (!rule || !hides(p, rule.from)) return read;
    const out = { ...read };
    for (const field of rule.hidden) delete out[field];
    // A secret title is hidden too: history must not name it.
    if (String(out.title ?? '').startsWith('secret:')) delete out.title;
    return out;
  },
};

/** What the write hook saw, and switches for the test. */
export const gate = {
  closed: false,
  failAfterRun: false,
  seen: [] as { op: string; status: string; touched: number }[],
};

/** A write hook on chore writes: refuses while closed, records every write, can fail it. */
export const choreGate: WriteHook = {
  name: 'fixture.chore-gate',
  decide: ({ op }) =>
    gate.closed && op.resourceType === 'chore'
      ? deny('fixture_closed', 'Chore writes are closed for now')
      : null,
  afterRun: ({ op, result, touched }) => {
    if (op.resourceType !== 'chore') return;
    gate.seen.push({ op: op.name, status: result.status, touched: touched.length });
    if (gate.failAfterRun) throw new Error('fixture: after run failed');
  },
};

/** chore.renamed: a command's event, with the record before. */
export class ChoreRenamed implements NamedEvent {
  readonly eventName = 'chore.renamed';
  constructor(
    readonly row: unknown,
    readonly before: unknown,
  ) {}
}

export const RenameChoreSpec = commandSpec({
  name: 'chore.rename',
  description: 'Rename a chore.',
  input: z.object({ choreId: z.uuid(), title }),
  // Reuses the entity's read schema: the result is projected as a chore.
  output: z.object({ chore: Chore, was: z.string() }),
  http: { method: 'POST', path: '/api/chores/:choreId/rename' },
  expose: 'all',
  touches: ['chore'],
});

export const RenameChore = defineCommand(RenameChoreSpec, {
  resource: { type: 'chore', id: (input) => input.choreId },
  load: (tx, p, input) => ChoreDef.repo.get(tx, p, input.choreId),
  authorize: (p) =>
    p.actor.kind === 'agent'
      ? needsApproval('agent_renames', 'Renames by the assistant need your approval')
      : allow('person_renames'),
  summarize: (input, chore) => `Rename "${chore.title}" to "${input.title}"`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const renamed = await ChoreDef.repo.update(tx, principal, loaded, { title: input.title }, via);
    return {
      value: { chore: renamed, was: loaded.title },
      touched: [
        { type: 'chore', id: renamed.id, change: 'updated', before: loaded, after: renamed },
      ],
      events: [new ChoreRenamed(renamed, loaded)],
    };
  },
});

@Module({
  controllers: [entityController(ChoreDef), commandController(RenameChore)],
  providers: [...entityHandlers(ChoreDef), commandHandler(RenameChore)],
})
export class WritePathModule {}

/**
 * A read projector, by resource type: staff never see what a chore was called before a rename,
 * nor why an approval waits.
 */
export const staffView: ReadProjector = {
  name: 'fixture.staff-view',
  project: (type, value, p) => {
    if (!p.roles?.includes('staff')) return value;
    const drop = type === 'chore.rename' ? 'was' : type === 'approval' ? 'reason' : undefined;
    if (!drop) return value;
    const { [drop]: _dropped, ...rest } = value;
    return rest;
  },
};

export const writePathContributions: Partial<Contributions> = {
  entityPlugins: [guarded],
  writeHooks: [choreGate],
  readProjectors: [staffView],
  listFieldSql: [
    {
      name: 'fixtureWords',
      where: ({ column, op, value }) =>
        op === 'hasWord'
          ? sql`${column} ~* ${`\\m${String(value)}\\M`}`
          : sql`${column} = ${value}`,
    },
  ],
};

/** Chores, as a module over the tasks module's table: it declares no table of its own. */
export const choresModule = defineModule({
  ...moduleSpec({
    name: 'chores',
    dependsOn: ['tasks'],
    entities: { chores: ChoreSpec },
    commands: [RenameChoreSpec],
  }),
  server: WritePathModule,
});

/** The fixture plus chores, served with the plugin, the hook and the field type. */
export const writePath = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, choresModule],
  contributes: writePathContributions,
});
