// The MCP tools from a catalog (A1), without a server: which tools a token's scopes give, what
// each one says, and how a parked write reads. The e2e test runs them for real.
import {
  createCatalog,
  moduleScopes,
  modulesCovered,
  parseScope,
  scopeCovers,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldsOf, mcpTools, parkedText } from '../../dist/features/mcp/index.js';
import { tasksSpec, visitsSpec } from '../fixture/dist/contracts.js';

const catalog = createCatalog(tasksSpec, visitsSpec);
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
