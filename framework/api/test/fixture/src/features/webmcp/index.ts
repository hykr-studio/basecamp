// A page's WebMCP tools reach the API on the person's session, naming the `webmcp` channel (A2).
// The fixture adds what the test needs around the tasks module: a read projector that hides a
// task's due date from staff, and a people-only `memo` entity over the tasks table (every action
// `expose: 'human'`). Only the WebMCP test's server (`webMcpServer`) loads this file.
import { defineModule, defineServer } from '@hykr/api';
import { CreatedBy, entitySpec, moduleSpec } from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers, type ReadProjector } from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { tasks } from '../../schema.js';

const title = z.string().min(1).max(200);

export const MemoSpec = entitySpec({
  name: 'memo',
  label: 'memo',
  description: 'Memos: people read and write them; no agent does.',
  schemas: {
    read: z.object({ id: z.string(), title, createdBy: CreatedBy, createdAt: z.iso.datetime() }),
    create: z.object({ title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  expose: { list: 'human', get: 'human', create: 'human', update: 'human', delete: 'human' },
});

const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const MemoDef = defineEntity(MemoSpec, {
  table: tasks,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

@Module({ controllers: [entityController(MemoDef)], providers: [...entityHandlers(MemoDef)] })
export class MemosModule {}

export const memosModule = defineModule({
  ...moduleSpec({
    name: 'memos',
    dependsOn: ['tasks'],
    entities: { memos: MemoSpec },
    commands: [],
  }),
  server: MemosModule,
});

/** Staff never see a task's due date, wherever a task leaves the server. */
export const dueDateFromStaff: ReadProjector = {
  name: 'fixture.webmcp-due-date',
  project: (type, value, p) => {
    if (type !== 'task' || !p.roles?.includes('staff')) return value;
    const { dueOn: _hidden, ...rest } = value;
    return rest;
  },
};

/** The fixture plus memos, with the projector. */
export const webMcpServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, memosModule],
  contributes: { readProjectors: [dueDateFromStaff] },
});
