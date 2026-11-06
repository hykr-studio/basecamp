// Memory and recall (A8) as an application meets them: a `memos` module whose memos are memory of
// a task (the `memory` trait), with a field only holders of a fixture capability may read, a
// command that changes a memo, and asides: memory people may read but the assistant may not. A
// tool hands the turn's context to the test, with a script for it. Only the memory e2e test boots
// `memoryApp`; its tables are a migration set of their own (migrations/, next to this file).
import { call, defineScript, say } from '@hykr/agents/script';
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  commandSpec,
  defineCapability,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  entityController,
  entityHandlers,
  type ReadProjector,
} from '@hykr/core';
import type { ToolContribution } from '@hykr/core/tools';
import { type Access, can } from '@hykr/policy';
import { createTool } from '@mastra/core/tools';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { asides, memos } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);

/** What each piece saw: the tests read it (the app runs in the test's process). */
export const seen = { contexts: [] as (readonly string[] | null)[] };

export const Memo = z.object({
  id: z.string(),
  title,
  body: z.string(),
  secret: z.string().nullable(),
  taskId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Memo = z.infer<typeof Memo>;

/** Memos: memory of the task they name. `secret` is part of their memory, for those who see it. */
export const MemoSpec = entitySpec({
  name: 'memo',
  label: 'memo',
  description: 'Memos about tasks: a title, a body, and the task.',
  schemas: {
    read: Memo,
    create: z.object({
      title,
      body: z.string().default(''),
      secret: z.string().optional(),
      taskId: z.uuid().optional(),
    }),
    update: z.object({
      title: title.optional(),
      body: z.string().optional(),
      secret: z.string().nullable().optional(),
      taskId: z.uuid().nullable().optional(),
    }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  traits: {
    memory: {
      // A memo titled "explode" breaks its trait: it must fail alone.
      text: (m: Memo) => {
        if (m.title === 'explode') throw new Error('this trait cannot read the memo');
        return [m.title, m.body, m.secret].filter(Boolean).join('. ');
      },
      about: (m: Memo) => (m.taskId ? { type: 'task', id: m.taskId } : null),
    },
  },
});

export const Aside = z.object({
  id: z.string(),
  title,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Asides: memory, but people only: the assistant may add one and never read it. */
export const AsideSpec = entitySpec({
  name: 'aside',
  label: 'aside',
  description: 'Asides: a title.',
  schemas: { read: Aside, create: z.object({ title }), update: z.object({ title }) },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  expose: { list: 'human', get: 'human', create: 'all', update: 'human', delete: 'human' },
  traits: { memory: { text: (a: { title: string }) => a.title } },
});

/** memo.restate: a new body, through a command (a command's writes publish no entity events). */
export const RestateMemoSpec = commandSpec({
  name: 'memo.restate',
  description: 'Give a memo a new body.',
  input: z.object({ memoId: z.uuid(), body: z.string() }),
  output: Memo,
  http: { method: 'POST', path: '/api/memos/:memoId/restate' },
  expose: 'all',
  touches: ['memo'],
});

/** Owners, admins and ops read every memo; staff their own. Writes the same. */
const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own' },
};

export const MemoDef = defineEntity(MemoSpec, {
  table: memos,
  owner: (t) => t.ownerId,
  access: ACCESS,
});

export const AsideDef = defineEntity(AsideSpec, {
  table: asides,
  owner: (t) => t.ownerId,
  access: ACCESS,
});

export const RestateMemo = defineCommand(RestateMemoSpec, {
  resource: { type: 'memo', id: (input) => input.memoId },
  load: (tx, p, input) => MemoDef.repo.get(tx, p, input.memoId),
  authorize: () => allow('fixture_restate'),
  summarize: (_input, memo) => `Restate ${memo.title}`,
  run: async ({ tx, principal, input, loaded: memo, via }) => {
    const changed = await MemoDef.repo.update(tx, principal, memo, { body: input.body }, via);
    return {
      value: changed,
      touched: [{ type: 'memo', id: memo.id, change: 'updated', before: memo, after: changed }],
    };
  },
});

@Module({
  controllers: [
    entityController(MemoDef),
    entityController(AsideDef),
    commandController(RestateMemo),
  ],
  providers: [...entityHandlers(MemoDef), ...entityHandlers(AsideDef), commandHandler(RestateMemo)],
})
export class MemosFixtureModule {}

/** Who reads a memo's secret: admins. */
export const MemoSecrets = defineCapability({
  name: 'memos.secret',
  label: label("Read memos' secrets"),
  roles: ['admin'],
});

/** A memo's secret is gone for everyone else, wherever it leaves the server. */
export const HideSecrets: ReadProjector = {
  name: 'fixture.memos.secret',
  project: (type, value, p) => {
    if (type !== 'memo' || can(p, MemoSecrets)) return value;
    const { secret: _secret, ...rest } = value;
    return rest;
  },
};

/** turn-context: the lines the turn hooks added to this turn, as the agent got them. */
export const ContextTools: ToolContribution = {
  name: 'fixture.memory.tools',
  tools: () => ({
    'turn-context': createTool({
      id: 'turn-context',
      description: "This turn's context lines.",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        const lines = (ctx?.requestContext?.get('turnContext') as readonly string[]) ?? null;
        seen.contexts.push(lines);
        return { ok: true, result: { lines } };
      },
    }),
  }),
};

/** "show context …": calls turn-context and says how many lines it got. */
export const memoryFixtureScripts = [
  defineScript({
    name: 'show-context',
    match: (text) => (/^show context\b/i.test(text.trim()) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('turn-context');
      if (!r) return [call('turn-context', {})];
      const lines = (r.result as { lines: string[] | null }).lines ?? [];
      return [say(`Context: ${lines.length} lines.`)];
    },
  }),
];

export const memoryContributions: Partial<Contributions> = {
  capabilities: [MemoSecrets],
  readProjectors: [HideSecrets],
  toolContributions: [ContextTools],
};

export const memosModule = defineModule({
  ...moduleSpec({
    name: 'memos',
    dependsOn: ['tasks'],
    entities: { memos: MemoSpec, asides: AsideSpec },
    commands: [RestateMemoSpec],
  }),
  server: MemosFixtureModule,
  agent: { scripts: memoryFixtureScripts },
  tables: { memos, asides },
});

/** The fixture, with everything above. */
export const memoryApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, memosModule],
  contributes: memoryContributions,
});
