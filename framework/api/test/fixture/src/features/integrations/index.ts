// The integration bus (B10) as an application uses it: a capability that a read projector needs
// before a task's due date leaves (so a webhook endpoint sees it only when given it), a write
// hook that parks an endpoint marked [ask], an entity whose events never leave, two HMAC
// connectors (one signs its body only, one its id and a timestamp too), and handlers that act on
// tasks as the business's system.
// Only the integrations e2e test boots `integrationsApp`.
import {
  type ConnectorHandler,
  defineConnectorHandler,
  defineModule,
  defineServer,
} from '@hykr/api';
import { hmacConnector } from '@hykr/connectors';
import {
  type Contributions,
  CreatedBy,
  defineCapability,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import {
  defineEntity,
  entityController,
  entityHandlers,
  entityOp,
  needsApproval,
  type ReadProjector,
  type WriteHook,
} from '@hykr/core';
import { type Access, can } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { tasks } from '../../schema.js';
import { Task } from '../../server.js';

/* ── Field policy: a task's due date needs a capability ─────────────────────── */

export const TaskDates = defineCapability({
  name: 'fixture.tasks.dates',
  label: { en: 'See due dates', hi: 'नियत तारीखें देखें', te: 'గడువు తేదీలు చూడండి' },
  roles: ['owner'],
});

/** Without `fixture.tasks.dates`, a task leaves without its due date: API, log and webhooks. */
export const taskDates: ReadProjector = {
  name: 'fixture.task-dates',
  project: (type, value, p) => {
    if (type !== 'task' || can(p, TaskDates)) return value;
    const { dueOn: _hidden, ...rest } = value;
    return rest;
  },
};

/* ── A write hook on the bus's own writes ──────────────────────────────────── */

/** An endpoint described "[ask]" waits for its creator's approval. */
export const askFirst: WriteHook = {
  name: 'fixture.integrations-ask',
  decide: ({ op, input }) =>
    op.name === 'integrations.endpoint.create' &&
    String((input as { description?: string }).description ?? '').includes('[ask]')
      ? needsApproval('fixture_endpoint_asks', 'An endpoint marked [ask] waits for approval')
      : null,
};

/* ── An entity whose events never leave ────────────────────────────────────── */

const title = z.string().min(1).max(200);

export const MemoSpec = entitySpec({
  name: 'memo',
  label: 'memo',
  description: 'Memos: kept inside, never sent to a webhook.',
  schemas: {
    read: z.object({ id: z.string(), title, createdBy: CreatedBy, createdAt: z.iso.datetime() }),
    create: z.object({ title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: {},
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: { webhooks: false },
});

const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own' },
};

export const Memo = defineEntity(MemoSpec, {
  table: tasks,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

@Module({ controllers: [entityController(Memo)], providers: [...entityHandlers(Memo)] })
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

/* ── Inbound: a sender of the fixture's own, and handlers ──────────────────── */

/**
 * Signs the raw body only: `x-fixture-signature: sha256=<hex>`, its event id in `x-fixture-event`,
 * which the signature leaves out. So its events are stored under a hash of the body.
 */
export const fixtureSender = hmacConnector({
  name: 'fixture-sender',
  label: { en: 'Fixture sender', hi: 'फ़िक्स्चर प्रेषक', te: 'ఫిక్స్చర్ పంపేవారు' },
  header: 'x-fixture-signature',
  prefix: 'sha256=',
  idHeader: 'x-fixture-event',
});

/**
 * Signs `<timestamp>.<id>.<body>`: `x-fixture-signature: sha256=<hex>`, with `x-fixture-event`
 * and `x-fixture-timestamp` (seconds). Its ids are signed, and a request goes stale in 300 s.
 */
export const fixtureSignedSender = hmacConnector({
  name: 'fixture-signed',
  label: {
    en: 'Fixture signed sender',
    hi: 'फ़िक्स्चर हस्ताक्षरित प्रेषक',
    te: 'ఫిక్స్చర్ సంతకం చేసే పంపేవారు',
  },
  header: 'x-fixture-signature',
  prefix: 'sha256=',
  idHeader: 'x-fixture-event',
  timestampHeader: 'x-fixture-timestamp',
  signedIds: true,
  signedContent: (req, { id, timestamp }) => `${timestamp}.${id}.${req.rawBody}`,
});

/** What the handlers saw, for the tests (the app runs in the test's process). */
export const handled = {
  calls: [] as { handler: string; type: string; actor: string; runId?: string }[],
  flaky: 0,
};

const TaskRef = z.object({ taskId: z.uuid() });

const completeTask = (name: string, connector: string, on: string[]): ConnectorHandler =>
  defineConnectorHandler({
    name,
    connector,
    on,
    handle: async (event, ctx) => {
      handled.calls.push({
        handler: name,
        type: event.type,
        actor: `${ctx.principal.actor.kind}:${ctx.principal.actor.id}`,
        runId: ctx.principal.runId,
      });
      const { taskId } = TaskRef.parse(event.data);
      await ctx.write(entityOp(Task, 'update', { id: taskId }), { done: true });
    },
  });

export const handlers: ConnectorHandler[] = [
  // 'task.complete' { taskId }: the task is done, written as the business's system.
  completeTask('fixture.complete-task', 'standard-webhooks', ['task.complete']),
  completeTask('fixture.sender-done', 'fixture-sender', ['done']),
  completeTask('fixture.signed-done', 'fixture-signed', ['done']),
  // Fails once for now, then works: the event is retried, the handler runs again.
  defineConnectorHandler({
    name: 'fixture.flaky',
    connector: 'standard-webhooks',
    on: ['flaky.*'],
    handle: async () => {
      handled.flaky += 1;
      if (handled.flaky === 1) throw new Error('fixture: try again later');
    },
  }),
];

/* ── The application ───────────────────────────────────────────────────────── */

export const integrationsContributions: Partial<Contributions> = {
  capabilities: [TaskDates],
  readProjectors: [taskDates],
  writeHooks: [askFirst],
  connectors: [fixtureSender, fixtureSignedSender],
  connectorHandlers: handlers,
};

/** The fixture, with memos and everything above. */
export const integrationsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, memosModule],
  contributes: integrationsContributions,
});
