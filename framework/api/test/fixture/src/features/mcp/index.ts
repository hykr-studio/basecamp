// MCP clients (A1): the fixture as it is, plus a read projector that hides a task's due date from
// staff, so the test sees a hidden field stay hidden through the MCP tools, and three feature
// flags (H3) a business switches to see its MCP tools follow them: one gates the visits module,
// one the visits' reschedule command, one the tasks' delete and counts tools. Only the MCP
// test's server (`mcpServer`) loads this file.
import { defineServer } from '@hykr/api';
import { defineFeatureFlag } from '@hykr/contracts';
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

const label = (en: string) => ({ en, hi: en, te: en });

/** The visits module, whole. */
export const VisitsFlag = defineFeatureFlag({
  key: 'fixture.mcp.visits',
  label: label('Visits'),
  managedBy: 'tenant',
  gates: { modules: ['visits'] },
});

/** Moving a visit. */
export const RescheduleFlag = defineFeatureFlag({
  key: 'fixture.mcp.reschedule',
  label: label('Reschedule visits'),
  managedBy: 'tenant',
  gates: { commands: ['visit.reschedule'] },
});

/** Deleting tasks, and their counts and totals, by tool id. */
export const TaskToolsFlag = defineFeatureFlag({
  key: 'fixture.mcp.task-tools',
  label: label('Delete and count tasks'),
  managedBy: 'tenant',
  gates: { tools: ['delete-task', 'summarize-tasks'] },
});

/** Every flag on: what the MCP test's businesses store unless a test says otherwise. */
export const ALL_ON = {
  [VisitsFlag.key]: true,
  [RescheduleFlag.key]: true,
  [TaskToolsFlag.key]: true,
};

export const mcpServer = defineServer({
  ...fixture.definition,
  contributes: {
    readProjectors: [dueDateHiddenFromStaff],
    featureFlags: [VisitsFlag, RescheduleFlag, TaskToolsFlag],
  },
});
