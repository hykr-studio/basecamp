// The MCP tools from a catalog (A1), without a server: which tools a token's scopes give, what
// each one says (its annotations too, H3), what a business's flags take away, and how a parked
// write reads. The e2e test runs them for real.
import {
  commandSpec,
  createCatalog,
  entitySpec,
  moduleScopes,
  moduleSpec,
  modulesCovered,
  parseScope,
  scopeCovers,
  scopesWithin,
} from '@hykr/contracts';
import type { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldsOf, mcpTools, parkedText } from '../../dist/features/mcp/index.js';
import { tasksSpec, visitsSpec } from '../fixture/dist/contracts.js';

const catalog = createCatalog(tasksSpec, visitsSpec);

const label = (en: string) => ({ en, hi: en, te: en });
/** A module whose one entity has states: its moves are write actions like any other. */
const choresSpec = moduleSpec({
  name: 'chores',
  entities: {
    chores: entitySpec({
      name: 'chore',
      label: 'chore',
      description: 'Chores: a title and a state.',
      schemas: {
        read: z.object({ id: z.string(), title: z.string(), status: z.string() }),
        create: z.object({ title: z.string() }),
        update: z.object({
          title: z.string().optional(),
          status: z.string().optional(),
          reason: z.string().max(200).optional(),
        }),
      },
      list: {
        filterable: { status: 'text' },
        sortable: ['title'],
        defaultSort: [['title', 'asc']],
        pageSize: { default: 20, max: 50 },
      },
      traits: {
        states: {
          field: 'status',
          initial: 'open',
          states: {
            open: { label: label('Open') },
            done: { label: label('Done') },
            dropped: { label: label('Dropped') },
          },
          transitions: [
            { name: 'finish', from: 'open', to: 'done' },
            {
              name: 'drop',
              from: ['open', 'done'],
              to: 'dropped',
              fields: ['reason'],
              requires: ['reason'],
              approval: (p) => p.actor.kind === 'agent',
              destructive: true,
            },
            { name: 'reopen', from: 'done', to: 'open', expose: 'human' },
            { name: 'expire', from: 'open', to: 'dropped', expose: 'system' },
          ],
        },
      },
    }),
  },
  commands: [],
});
/** A module whose only write is a command the application marks destructive. */
const archiveSpec = moduleSpec({
  name: 'archive',
  entities: {},
  commands: [
    commandSpec({
      name: 'archive.purge',
      description: 'Purge the archive.',
      input: z.object({ before: z.iso.date() }),
      output: z.object({ purged: z.number() }),
      http: { method: 'POST', path: '/api/archive/purge' },
      tool: 'purge-archive',
      expose: 'all',
      traits: { destructive: true },
    }),
  ],
});

type Tool = ReturnType<typeof createTool>;
const notes = (tool: Tool) => (tool as { mcp?: { annotations?: object } }).mcp?.annotations;
const off = (o: Partial<Record<'modules' | 'entities' | 'commands' | 'tools', string[]>>) => ({
  modules: [],
  entities: [],
  commands: [],
  tools: [],
  nav: [],
  ...o,
});

const kit = {
  apiUrl: () => 'http://api.invalid',
  appUrl: 'https://app.example',
  callerOf: () => undefined,
};

describe('scopes', () => {
  it('are read and write per module, and write covers read', () => {
    expect(moduleScopes(catalog.modules)).toEqual([
      'tasks:read',
      'tasks:write',
      'visits:read',
      'visits:write',
    ]);
    expect(scopeCovers(['tasks:write'], 'tasks', 'read')).toBe(true);
    expect(scopeCovers(['tasks:read'], 'tasks', 'write')).toBe(false);
    expect(scopeCovers(['tasks:read'], 'visits', 'read')).toBe(false);
    expect(scopeCovers(['offline_access'], 'tasks', 'read')).toBe(false);
    expect(parseScope('visits:write')).toEqual({ module: 'visits', access: 'write' });
    expect(parseScope('offline_access')).toBeNull();
    expect(parseScope('Tasks:read')).toBeNull();
    expect(modulesCovered(catalog.modules, ['visits:read'], 'read').map((m) => m.name)).toEqual([
      'visits',
    ]);
  });

  it('are cut down to what is still granted, a write the grant only reads becoming that read', () => {
    const token = ['tasks:write', 'visits:write', 'offline_access'];
    expect(scopesWithin(token, ['tasks:write', 'visits:write', 'offline_access'])).toEqual(token);
    expect(scopesWithin(token, ['tasks:read', 'offline_access'])).toEqual([
      'tasks:read',
      'offline_access',
    ]);
    expect(scopesWithin(['tasks:read'], ['tasks:write'])).toEqual(['tasks:read']);
    expect(scopesWithin(['tasks:write'], ['visits:write'])).toEqual([]);
    expect(scopesWithin(['tasks:read', 'tasks:write'], ['tasks:read'])).toEqual(['tasks:read']);
    expect(scopesWithin(token, [])).toEqual([]);
  });
});

describe('the tools a token gets', () => {
  it('two per module it reaches, none for a module it does not', () => {
    expect(Object.keys(mcpTools(catalog, ['tasks:write', 'visits:write'], kit))).toEqual([
      'tasks_read',
      'visits_read',
      'tasks_write',
      'visits_write',
    ]);
    expect(Object.keys(mcpTools(catalog, ['tasks:read'], kit))).toEqual(['tasks_read']);
    expect(Object.keys(mcpTools(catalog, ['offline_access'], kit))).toEqual([]);
  });

  it('describe the entities, the list grammar and every action an agent may take', () => {
    const tools = mcpTools(catalog, ['tasks:write', 'visits:write'], kit);
    const read = tools.tasks_read.description ?? '';
    expect(read).toContain('"tasks"');
    expect(read).toContain('Filter on done (boolean)');
    const tasksWrite = tools.tasks_write.description ?? '';
    for (const action of ['create-task', 'update-task', 'delete-task'])
      expect(tasksWrite).toContain(`- ${action}:`);
    expect(tasksWrite).toContain('title (string)');
    // Visits are deleted by people only: no delete action; the command is there.
    const visitsWrite = tools.visits_write.description ?? '';
    expect(visitsWrite).not.toContain('delete-visit');
    expect(visitsWrite).toContain('- reschedule-visit: Move a visit');
    expect(visitsWrite).toContain('visitId (string, uuid)');
  });
});

describe('what each tool says it does', () => {
  it('a read tool only reads, idempotently, in a closed world', () => {
    const tools = mcpTools(catalog, ['tasks:write', 'visits:write'], kit);
    expect(notes(tools.tasks_read)).toEqual({
      title: 'Read tasks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('a write tool changes things, and is destructive when one of its actions deletes', () => {
    const tools = mcpTools(catalog, ['tasks:write', 'visits:write'], kit);
    expect(notes(tools.tasks_write)).toEqual({
      title: 'Change tasks',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    // Visits: create, update and a reschedule command, nothing that deletes.
    expect(notes(tools.visits_write)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('a command or a move the application marks destructive makes its tool destructive', () => {
    const purge = mcpTools(createCatalog(archiveSpec), ['archive:write'], kit);
    expect(notes(purge.archive_write)).toMatchObject({ destructiveHint: true });
    const chores = mcpTools(createCatalog(tasksSpec, choresSpec), ['chores:write'], kit);
    expect(notes(chores.chores_write)).toMatchObject({ destructiveHint: true });
    const kept = createCatalog(tasksSpec, {
      ...choresSpec,
      entities: {
        chores: {
          ...choresSpec.entities.chores,
          // People delete chores; the agent only adds, changes and finishes them.
          expose: { ...choresSpec.entities.chores.expose, delete: 'human' },
          traits: {
            states: {
              ...(choresSpec.entities.chores.traits?.states as object),
              transitions: [{ name: 'finish', from: 'open', to: 'done' }],
            },
          },
        },
      },
    } as typeof choresSpec);
    expect(notes(mcpTools(kept, ['chores:write'], kit).chores_write)).toMatchObject({
      destructiveHint: false,
    });
  });
});

describe('what a business switched off', () => {
  const scopes = ['tasks:write', 'visits:write'];

  it('a module that is off gives no tool', () => {
    expect(Object.keys(mcpTools(catalog, scopes, kit, off({ modules: ['visits'] })))).toEqual([
      'tasks_read',
      'tasks_write',
    ]);
  });

  it('an entity that is off leaves both tools; its module keeps its commands', () => {
    const tools = mcpTools(catalog, scopes, kit, off({ entities: ['visit'] }));
    // As for the assistant (A11): an entity's gate is its own tools, a command has its own.
    expect(Object.keys(tools)).toEqual(['tasks_read', 'tasks_write', 'visits_write']);
    expect(tools.visits_write.description).toContain('- reschedule-visit:');
    expect(tools.visits_write.description).not.toContain('create-visit');
    const both = off({ entities: ['visit'], commands: ['visit.reschedule'] });
    expect(Object.keys(mcpTools(catalog, scopes, kit, both))).toEqual([
      'tasks_read',
      'tasks_write',
    ]);
  });

  it('a command or a tool id that is off leaves the write actions (and the reads)', () => {
    const tools = mcpTools(
      catalog,
      scopes,
      kit,
      off({ commands: ['visit.reschedule'], tools: ['delete-task', 'summarize-tasks'] }),
    );
    expect(tools.visits_write.description).not.toContain('reschedule-visit');
    expect(tools.visits_write.description).toContain('- create-visit:');
    expect(tools.tasks_write.description).not.toContain('delete-task');
    expect(notes(tools.tasks_write)).toMatchObject({ destructiveHint: false });
    expect(tools.tasks_read.description).not.toContain('counts and totals with "summary"');
    // A get named off leaves the list.
    const noGet = mcpTools(catalog, ['tasks:read'], kit, off({ tools: ['get-task'] }));
    expect(noGet.tasks_read.description).not.toContain('one by "id"');
    expect(noGet.tasks_read.description).toContain('a list with "query"');
  });

  it('a write tool whose every action is off is not listed', () => {
    const tools = mcpTools(
      catalog,
      ['visits:write'],
      kit,
      off({ tools: ['create-visit', 'update-visit'], commands: ['visit.reschedule'] }),
    );
    expect(Object.keys(tools)).toEqual(['visits_read']);
  });
});

describe('state transitions', () => {
  it("are a write action of the entity's module: the moves an agent may ask for, with their fields", () => {
    const tools = mcpTools(createCatalog(tasksSpec, choresSpec), ['chores:write'], kit);
    const write = tools.chores_write.description ?? '';
    expect(write).toContain(
      '- transition-chores: move a chore to another status. input: id (string), transition (one of finish|drop)',
    );
    expect(write).toContain('finish (open → done)');
    expect(write).toContain(
      'drop (open or done → dropped; may wait for approval; needs reason; fields: reason? (string))',
    );
    // People-only and the server's own moves are not offered.
    expect(write).not.toContain('reopen');
    expect(write).not.toContain('expire');
    // A module without states has no transition action.
    const tasks = mcpTools(catalog, ['tasks:write'], kit).tasks_write.description ?? '';
    expect(tasks).not.toContain('transition-');
  });
});

describe('words', () => {
  it('lists fields, marking the optional ones', () => {
    expect(fieldsOf(z.object({ title: z.string(), dueOn: z.iso.date().optional() }))).toBe(
      'title (string), dueOn? (string, date)',
    );
    expect(fieldsOf(z.object({ kind: z.enum(['a', 'b']) }))).toBe('kind (one of a|b)');
  });

  it('a parked write names who decides and links to the request in the app', () => {
    const text = parkedText(
      {
        id: '00000000-0000-4000-8000-000000000001',
        action: 'task.delete',
        rule: 'task_delete_needs_approval',
        reason: 'An agent asked',
        status: 'pending',
        summary: 'Delete "Order tiles"',
        resourceType: 'task',
        resourceId: null,
        input: {},
        requestedBy: 'agent',
        expiresAt: '2031-01-01T00:00:00.000Z',
        failureReason: null,
        decider: { by: 'requester' },
        level: { name: 'big', label: { en: 'Big', hi: 'Big', te: 'Big' } },
      },
      'https://app.example',
    );
    expect(text).toContain('Not done yet: it waits for approval (Delete "Order tiles").');
    expect(text).toContain('The person you act for decides it.');
    expect(text).toContain('Level: Big.');
    expect(text).toContain('https://app.example/approvals/00000000-0000-4000-8000-000000000001');
  });
});
