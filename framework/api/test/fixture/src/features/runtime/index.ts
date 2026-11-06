// The runtime registries (F5) as an application uses them: its own queue with a processor and a
// schedule, subscribers to committed events, turn hooks, contributed tools with scripts for the
// scripted model, a delivery channel and a notification without a WhatsApp template, an inbound
// hook written as a Nest provider, and erasure and export contributors. Only the runtime and
// delivery e2e tests boot `runtimeApp`; what each piece saw is kept in `seen` for the tests.

import { call, defineScript, type Outcome, say, written } from '@hykr/agents/script';
import {
  type DeliveryChannel,
  type DeliveryRequest,
  defineModule,
  defineQueue,
  defineSchedule,
  defineServer,
  defineSubscriber,
  type ErasureContributor,
  type ExportContributor,
  type InboundHook,
  type InboundInfo,
  inboundHooks,
  type TurnHook,
  type TurnInfo,
  type TurnOutcome,
} from '@hykr/api';
import {
  type Contributions,
  type DomainEventEnvelope,
  moduleSpec,
  type Subject,
} from '@hykr/contracts';
import { CORE_OPTIONS, type CoreOptions } from '@hykr/core';
import { safely, type ToolContribution } from '@hykr/core/tools';
import { defineNotification, type Row } from '@hykr/notifications';
import { createTool } from '@mastra/core/tools';
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { TaskSpec } from '../../contracts.js';
import { fixture } from '../../index.js';

declare module '@hykr/notifications' {
  interface NotificationChannels {
    'fixture-pager': true;
  }
}

/** What each piece saw, in order: the tests read it (the app runs in the test's process). */
export const seen = {
  jobs: [] as { tenantId: string; found: number }[],
  events: [] as DomainEventEnvelope[],
  forwarded: [] as { job: string; event: DomainEventEnvelope }[],
  before: [] as TurnInfo[],
  after: [] as { turn: TurnInfo; outcome: TurnOutcome }[],
  deliveries: [] as DeliveryRequest[],
  inbound: [] as InboundInfo[],
  erased: [] as { subject: Subject; tenantId?: string }[],
};

/* ── A queue with its own processor, and a schedule on it ──────────────────── */

/** Counts the business it is given, through the context's database: services reach a job. */
export const WorkQueue = defineQueue<{ tenantId: string }, number>({
  name: 'fixture.runtime.work',
  attempts: 2,
  backoffMs: 100,
  process: async (job, ctx) => {
    const result = await ctx.db.execute(
      sql`select count(*)::int as n from app.tenants where id = ${job.data.tenantId}`,
    );
    const found = Number((result.rows[0] as { n: number }).n);
    seen.jobs.push({ tenantId: job.data.tenantId, found });
    return found;
  },
});

/** Hourly on the work queue (the nil business: it finds nothing). */
export const TickSchedule = defineSchedule({
  name: 'fixture.runtime.tick',
  queue: WorkQueue.name,
  every: 3_600_000,
  data: { tenantId: '00000000-0000-0000-0000-000000000000' },
});

/** Where the forwarding subscriber sends its events. */
export const InboxQueue = defineQueue<DomainEventEnvelope>({
  name: 'fixture.runtime.inbox',
  process: async (job) => {
    seen.forwarded.push({ job: job.name, event: job.data });
  },
});

/* ── Subscribers ───────────────────────────────────────────────────────────── */

/** Every task event, run on the shared events queue. */
export const TaskEvents = defineSubscriber({
  name: 'fixture.runtime.tasks',
  on: ['task.*'],
  handle: async (event) => {
    seen.events.push(event);
  },
});

/** Created tasks titled "Forward…", added to the inbox queue as they are. */
export const ForwardTasks = defineSubscriber({
  name: 'fixture.runtime.forward',
  on: ['task.created'],
  when: (e) => String((e.row as { title?: string }).title).startsWith('Forward'),
  queue: InboxQueue.name,
});

/* ── Turn hooks ────────────────────────────────────────────────────────────── */

/** "refuse …" is refused; "turn shape" gets context, a model, and loses delete-task. */
export const GateHook: TurnHook = {
  name: 'fixture.runtime.gate',
  before: async (turn) => {
    seen.before.push(turn);
    if (turn.message.startsWith('refuse'))
      return {
        refuse: {
          rule: 'fixture_refused',
          reason: 'The fixture refuses this turn',
          status: 402,
          say: {
            en: 'Your credits are used up.',
            hi: 'आपके क्रेडिट खत्म हो गए।',
            te: 'మీ క్రెడిట్లు అయిపోయాయి.',
          },
        },
      };
    if (turn.message.includes('turn shape'))
      return {
        context: ['The secret word is papaya.'],
        // A registered model (the scripted one): the model policy checks what a hook asks for.
        model: 'fake/scripted',
        withoutTools: ['delete-task'],
      };
    return null;
  },
  after: async (turn, outcome) => {
    seen.after.push({ turn, outcome });
  },
};

/**
 * A second opinion: its context joins, its model loses to the first (it is no model of the
 * deployment: had it won, the turn would be refused), its removal adds up.
 */
export const SecondHook: TurnHook = {
  name: 'fixture.runtime.second',
  before: async (turn) =>
    turn.message.includes('turn shape')
      ? {
          context: ['Second line.'],
          model: 'fixture/second',
          withoutTools: ['canvas-open'],
        }
      : null,
};

/* ── Contributed tools, and the scripted model's scripts for them ──────────── */

export const RuntimeTools: ToolContribution = {
  name: 'fixture.runtime.tools',
  tools: (kit) => ({
    'count-tasks': createTool({
      id: 'count-tasks',
      description: 'Count the tasks.',
      inputSchema: z.object({}),
      execute: async (_input, ctx) =>
        safely('count-tasks', ctx, kit, async () => ({
          count: (await kit.clientFor(ctx).entity(TaskSpec).list({ limit: 100 })).items.length,
        })),
    }),
    'peek-task': createTool({
      id: 'peek-task',
      description: 'Read one task.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }, ctx) =>
        safely('peek-task', ctx, kit, () => kit.clientFor(ctx).entity(TaskSpec).get(id)),
    }),
    'archive-task': createTool({
      id: 'archive-task',
      description: 'Archive (delete) one task.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }, ctx) =>
        safely('archive-task', ctx, kit, () => kit.clientFor(ctx).entity(TaskSpec).remove(id)),
    }),
    'turn-shape': createTool({
      id: 'turn-shape',
      description: 'What the turn hooks decided.',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => ({
        ok: true,
        result: {
          context: ctx?.requestContext?.get('turnContext') ?? null,
          model: ctx?.requestContext?.get('model') ?? null,
          without: ctx?.requestContext?.get('withoutTools') ?? null,
        },
      }),
    }),
  }),
};

const resultOf = <T>(o: Outcome) => o.result as T;

export const runtimeScripts = [
  defineScript({
    name: 'count',
    match: (text) => (/^count tasks$/i.test(text.trim()) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('count-tasks');
      if (!r) return [call('count-tasks', {})];
      return [say(`You have ${resultOf<{ count: number }>(r).count} tasks.`)];
    },
  }),
  defineScript({
    name: 'peek',
    match: (text) => /^peek (\S+)$/i.exec(text.trim())?.[1],
    step: (id, turn) => {
      const r = turn.result('peek-task');
      if (!r) return [call('peek-task', { id })];
      return [say(`Fields: ${Object.keys(resultOf<object>(r)).sort().join(', ')}.`)];
    },
  }),
  defineScript({
    name: 'archive',
    match: (text) => /^archive (\S+)$/i.exec(text.trim())?.[1],
    step: (id, turn) => {
      const r = turn.result('archive-task');
      if (!r) return [call('archive-task', { id })];
      return [say(written(r, () => 'Archived.', turn))];
    },
  }),
  defineScript({
    name: 'shape',
    match: (text) => (text.includes('turn shape') ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('turn-shape');
      if (!r) return [call('turn-shape', {})];
      return [say(JSON.stringify(r.result))];
    },
  }),
  defineScript({
    name: 'photo',
    match: (text) => /photo received (\S+)/.exec(text)?.[1],
    step: (file) => [say(`Got your photo ${file}.`)],
  }),
];

/* ── A delivery channel, and a notification that never goes by WhatsApp ───── */

/** How many times each task was paged: "flaky" fails once for now. */
const pages = new Map<string, number>();

/** By the task's title: "away" can't be reached, "broken" fails for good, "flaky" once for now. */
export const Pager: DeliveryChannel = {
  name: 'fixture-pager',
  deliver: async (req) => {
    seen.deliveries.push(req);
    const title = String(req.row.title);
    const n = (pages.get(req.row.id) ?? 0) + 1;
    pages.set(req.row.id, n);
    if (title.includes('away')) return { status: 'unavailable', reason: 'no pager' };
    if (title.includes('broken')) return { status: 'failed', reason: 'pager broken', final: true };
    if (title.includes('flaky') && n === 1)
      return { status: 'failed', reason: 'try later', final: false };
    return { status: 'sent', ref: `page-${req.row.id}-${n}` };
  },
};

type TaskRow = Row & { title: string; ownerId: string };

/** A task titled "Page…", to its owner: by pager, else by email. No template. */
export const PagedNotification = defineNotification<TaskRow>({
  key: 'task.paged',
  topic: 'service',
  send: { on: ['task.created'] },
  when: (t) => t.title.startsWith('Page'),
  to: (t) => [{ userId: t.ownerId }],
  channels: ['fixture-pager', 'email'],
  email: { subject: (t) => `Paged: ${t.title}`, body: (t) => `${t.title} was paged.` },
  dedupe: (t) => `task.paged:${t.id}`,
});

/* ── An inbound hook that needs a service: a Nest provider that registers itself ── */

@Injectable()
export class MediaHook implements InboundHook, OnModuleInit {
  readonly name = 'fixture.runtime.media';

  constructor(@Inject(CORE_OPTIONS) private readonly core: CoreOptions) {}

  onModuleInit() {
    inboundHooks.register(this);
  }

  /** A photo: kept out of the turn when captioned "keep", otherwise named for the turn. */
  async onMessage(info: InboundInfo) {
    if (info.message.body.kind !== 'media') return null;
    await this.core.db.execute(sql`select 1`);
    seen.inbound.push(info);
    if (info.message.body.caption === 'keep') return { handled: true as const };
    return { context: [`photo received ${info.message.body.mediaId}`] };
  }
}

@Module({ providers: [MediaHook] })
export class RuntimeFixtureModule {}

/* ── Personal data ─────────────────────────────────────────────────────────── */

export const EraseNotes: ErasureContributor = {
  name: 'fixture.runtime.erase',
  erase: async ({ subject, tenantId, tx }) => {
    await tx.execute(sql`select 1`);
    seen.erased.push({ subject, ...(tenantId ? { tenantId } : {}) });
    return { count: 1 };
  },
};

export const ExportNotes: ExportContributor = {
  name: 'fixture.runtime.export',
  export: async ({ subject }) => ({ fixtureNotes: [{ about: subject }] }),
};

/* ── The application ───────────────────────────────────────────────────────── */

export const runtimeContributions: Partial<Contributions> = {
  queues: [WorkQueue, InboxQueue],
  schedules: [TickSchedule],
  subscribers: [TaskEvents, ForwardTasks],
  turnHooks: [GateHook, SecondHook],
  toolContributions: [RuntimeTools],
  deliveryChannels: [Pager],
  erasureContributors: [EraseNotes],
  exportContributors: [ExportNotes],
};

/** The pieces a module carries: the inbound hook's provider, the notification and the scripts. */
export const runtimeModule = defineModule({
  ...moduleSpec({ name: 'runtime', dependsOn: ['tasks'], entities: {}, commands: [] }),
  server: RuntimeFixtureModule,
  notifications: [PagedNotification],
  agent: { scripts: runtimeScripts },
});

/** The fixture, with everything above. */
export const runtimeApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, runtimeModule],
  contributes: runtimeContributions,
});
