// The agent's tool set: generated tools plus contributions, each tool id defined once.
import { commandSpec, entitySpec } from '@hykr/contracts';
import type { Registry } from '@hykr/ui-registry';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolContributions } from './contributions.js';
import { generatedTools, toolsFor, withContributions } from './tools-for.js';

const NoteSpec = entitySpec({
  name: 'note',
  label: 'note',
  description: 'Notes.',
  schemas: {
    read: z.object({ id: z.string(), body: z.string() }),
    create: z.object({ body: z.string() }),
    update: z.object({ body: z.string().optional() }),
  },
  list: {
    filterable: { body: 'text' },
    sortable: [],
    defaultSort: [],
    search: [],
    pageSize: { default: 10, max: 10 },
  },
});

const kit = {
  clientFor: () => {
    throw new Error('not called');
  },
  registry: { getViewDef: () => undefined } as unknown as Registry,
};
const tool = (id: string) =>
  createTool({ id, description: id, inputSchema: z.object({}), execute: async () => ({}) });

describe('the agent’s tools', () => {
  it('generated tools say who made each one', () => {
    const set = generatedTools(
      kit,
      { entities: { notes: NoteSpec }, commands: [] },
      { canvas: false },
    );
    expect(Object.keys(set.tools).sort()).toEqual([
      'create-note',
      'delete-note',
      'get-note',
      'list-notes',
      'summarize-notes',
      'update-note',
    ]);
    expect(set.owners.get('list-notes')).toBe('entity note');
    expect(set.owners.get('summarize-notes')).toBe('entity note');
  });

  it('a command named like an entity tool is refused', () => {
    const Clash = commandSpec({
      name: 'note.list',
      description: 'Clashes.',
      input: z.object({}),
      output: z.object({}),
      http: { method: 'POST', path: '/api/notes/clash' },
      tool: 'list-notes',
      expose: 'all',
    });
    expect(() =>
      generatedTools(kit, { entities: { notes: NoteSpec }, commands: [Clash] }, { canvas: false }),
    ).toThrow('The tool "list-notes" is defined twice: by entity note and by command note.list');
  });

  it('contributions join the generated tools; a taken id is refused, naming both', () => {
    const base = generatedTools(
      kit,
      { entities: { notes: NoteSpec }, commands: [] },
      { canvas: false },
    );
    toolContributions.register({
      name: 'memory',
      tools: () => ({ 'recall-memory': tool('recall-memory') }),
    });
    const tools = toolsFor(kit, { entities: { notes: NoteSpec }, commands: [] }, { canvas: false });
    expect(Object.keys(tools)).toContain('recall-memory');
    expect(withContributions(kit, base).owners.get('recall-memory')).toBe('contribution memory');

    toolContributions.register({ name: 'again', tools: () => ({ 'recall-memory': tool('x') }) });
    expect(() => withContributions(kit, base)).toThrow(
      'The tool "recall-memory" is defined twice: by contribution memory and by contribution again',
    );
  });
});
