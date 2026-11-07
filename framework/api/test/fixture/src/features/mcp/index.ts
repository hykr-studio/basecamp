// MCP clients (A1): the fixture as it is, plus a read projector that hides a task's due date from
// staff, so the test sees a hidden field stay hidden through the MCP tools. Only the MCP test's
// server (`mcpServer`) loads this file.
import { defineServer } from '@hykr/api';
import type { ReadProjector } from '@hykr/core';
import { fixture } from '../../index.js';

/** Staff never see a task's due date, wherever a task leaves the server. */
export const dueDateHiddenFromStaff: ReadProjector = {
  name: 'fixture.mcp-due-date',
  project: (type, value, p) => {
    if (type !== 'task' || !p.roles?.includes('staff')) return value;
    const { dueOn: _hidden, ...rest } = value;
    return rest;
  },
};

export const mcpServer = defineServer({
  ...fixture.definition,
  contributes: { readProjectors: [dueDateHiddenFromStaff] },
});
