// The runtime registries (F5): queues and schedules from the registry, subscribers to committed
// events, turn hooks, the agent's per-turn model, tools and instructions, and contributed tools
// that act through the API as the person. The fixture's features/runtime contributes one of each.
import type { DomainEventEnvelope } from '@hykr/contracts';
import { RequestContext } from '@mastra/core/request-context';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxFeed } from '../../dist/features/events/outbox-feed.js';
import { EventRelay } from '../../dist/features/events/relay.service.js';
import * as api from '../../dist/index.js';
import { DB } from '../../dist/infra/db.module.js';
import { ChatService } from '../../dist/modules/chat/chat.service.js';
import { JOBS } from '../../dist/queues/define.js';
import {
  boot,
  eventually,
  me,
  Person,
  pool,
  runtime,
  server,
  shutdown,
} from '../../dist/testing.js';
import { runtimeApp, seen } from '../fixture/dist/features/runtime/index.js';

const ana = new Person('Ana Runtime');
const ravi = new Person('Ravi Runtime');
let anaTenant = '';
let raviTenant = '';

type Jobs = {
  add(q: string, data: unknown, o?: object): Promise<unknown>;
  queue(n: string): Queue;
};
const jobs = () => server.app?.get(JOBS) as Jobs;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await boot(runtimeApp);
  await ana.signUp();
  await ravi.signUp();
  anaTenant = (await me(ana)).tenantId;
  raviTenant = (await me(ravi)).tenantId;
});
afterAll(shutdown);

describe('queues and schedules', () => {
  it('the registry holds the channel queues, the events queue and the app’s', () => {
    const names = api.queues.all().map((q) => q.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'wa-inbound',
        'wa-send',
        'notify-dispatch',
        'templates-sync',
        'channel-maintenance',
        'events',
        'fixture.runtime.work',
        'fixture.runtime.inbox',
      ]),
    );
  });

  it('a contributed queue runs its jobs in the worker, with the context’s services', async () => {
    await jobs().add('fixture.runtime.work', { tenantId: anaTenant });
    const done = await eventually(() => seen.jobs.find((j) => j.tenantId === anaTenant));
    expect(done.found).toBe(1);
  });

  it('runs under this process’s queue prefix', () => {
    expect(jobs().queue('fixture.runtime.work').opts.prefix).toBe(process.env.BULL_PREFIX);
  });

  it('a schedule is upserted on its queue', async () => {
    const schedulers = await jobs().queue('fixture.runtime.work').getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain('fixture.runtime.tick');
    expect(schedulers.find((s) => s.key === 'fixture.runtime.tick')?.every).toBe(3_600_000);
  });

  it('a bad name, a schedule with both every and cron, an unknown queue: refused', () => {
    expect(() => api.defineQueue({ name: 'Bad:Name' })).toThrow('lower case words');
    expect(() => api.defineQueue({ name: 'fixture.x', attempts: 0 })).toThrow('positive');
    expect(() =>
      api.defineSchedule({
        name: 'fixture.both',
        queue: 'events',
        every: 60_000,
        cron: '* * * * *',
      }),
    ).toThrow('exactly one of every and cron');
    expect(() => api.defineSchedule({ name: 'fixture.fast', queue: 'events', every: 10 })).toThrow(
      'at least 1000',
    );
    expect(() => jobs().queue('fixture.nowhere')).toThrow('No queue is registered');
  });

  it('a queue name is unique: a contribution cannot take a channel queue', () => {
    expect(() => api.registerQueue({ name: 'wa-send' })).toThrow('registered twice');
  });
});

describe('events and subscribers', () => {
  it('a subscriber on task.* gets the creator’s business, the record and its id', async () => {
    const created = await ana.call('POST', '/api/tasks', { title: 'Order paper' });
    const id = created.body.value.id;
    const event = await eventually(() =>
      seen.events.find((e) => e.name === 'task.created' && e.resourceId === id),
    );
    expect(event).toMatchObject({
      tenantId: anaTenant,
      resourceType: 'task',
      row: { id, title: 'Order paper', tenantId: anaTenant },
    });
    await ana.call('PATCH', `/api/tasks/${id}`, { done: true });
    await eventually(() =>
      seen.events.find((e) => e.name === 'task.updated' && e.resourceId === id),
    );
  });

  it('another business’s events carry that business, never this one', async () => {
    const created = await ravi.call('POST', '/api/tasks', { title: 'Ravi only' });
    const id = created.body.value.id;
    const event = await eventually(() => seen.events.find((e) => e.resourceId === id));
    expect(event.tenantId).toBe(raviTenant);
    expect(
      seen.events.filter((e) => e.tenantId === anaTenant).map((e) => e.resourceId),
    ).not.toContain(id);
  });

  it('a stored row that is not an event, or that a filter throws on, fails alone', async () => {
    const now = Date.now();
    const bad = { notEvent: `evt-bad-${now}`, filterThrows: `evt-throws-${now}` };
    const insert = (id: string, channel: string | null, row: string | null) =>
      pool.query(
        `insert into app.domain_events (id, tenant_id, name, resource_type, resource_id, row,
           actor_kind, actor_id, channel, occurred_at, available_at, queues)
         values ($1, $2, 'task.created', 'task', null, $3::jsonb, 'user', $4, $5, now(), now(), $6)`,
        [id, anaTenant, row, ana.id, channel, process.env.BULL_PREFIX],
      );
    // Not a channel the envelope knows: the row can never be read as an event.
    await insert(bad.notEvent, 'bogus', '{}');
    // No record: the fixture's `when` (a title that starts with "Forward") throws on it.
    await insert(bad.filterThrows, null, null);
    // Another business's write, after them: it still reaches its subscriber.
    const created = await ravi.call('POST', '/api/tasks', { title: 'After the bad rows' });
    expect(created.status).toBe(201);
    await eventually(() => seen.events.find((e) => e.resourceId === created.body.value.id));
    const rows = await eventually(async () => {
      const r = await pool.query(
        'select id, relayed_at, failed_at, error from app.domain_events where id = any($1)',
        [Object.values(bad)],
      );
      return r.rows.every((x) => x.failed_at) ? r.rows : undefined;
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[bad.notEvent].relayed_at).toBeNull();
    expect(byId[bad.notEvent].error).toContain('channel');
    expect(byId[bad.filterThrows].relayed_at).toBeNull();
    expect(byId[bad.filterThrows].error).toContain('fixture.runtime.forward');
    expect(seen.events.filter((e) => Object.values(bad).includes(e.id))).toEqual([]);
    // Never returned again.
    const ctx = { db: server.app?.get(DB, { strict: false }) } as never;
    const prefix = String(process.env.BULL_PREFIX);
    const pending = await outboxFeed.pending({ limit: 10_000, prefix }, ctx);
    for (const id of Object.values(bad)) expect(pending.map((e) => e.id)).not.toContain(id);
  });

  it('a batch with a bad event relays the others', async () => {
    const relay = server.app?.get(EventRelay, { strict: false }) as EventRelay & {
      relay(events: unknown[]): Promise<{ relayed: string[]; failed: { id: string }[] }>;
    };
    const good = {
      id: `evt-good-${Date.now()}`,
      name: 'task.created',
      tenantId: raviTenant,
      resourceType: 'task',
      resourceId: null,
      row: { title: 'Good' },
      actor: { kind: 'user', id: ravi.id },
      occurredAt: new Date().toISOString(),
    };
    const out = await relay.relay([
      { ...good, id: `${good.id}-bad`, occurredAt: 'yesterday' },
      good,
    ]);
    expect(out.relayed).toEqual([good.id]);
    expect(out.failed.map((f) => f.id)).toEqual([`${good.id}-bad`]);
    await eventually(() => seen.events.find((e) => e.id === good.id));
  });

  it('relaying the same event twice runs it once', async () => {
    const relay = server.app?.get(EventRelay, { strict: false }) as EventRelay;
    const event: DomainEventEnvelope = {
      id: `evt-twice-${Date.now()}`,
      name: 'task.noted',
      tenantId: anaTenant,
      resourceType: 'task',
      resourceId: null,
      row: { note: 'once' },
      actor: { kind: 'system', id: 'test' },
      occurredAt: new Date().toISOString(),
    };
    await relay.publish([event, event]);
    await relay.publish([event]);
    await eventually(() => seen.events.find((e) => e.id === event.id));
    await wait(500);
    expect(seen.events.filter((e) => e.id === event.id)).toHaveLength(1);
  });

  it('a subscriber with a queue gets the envelope on that queue, filtered by when', async () => {
    const kept = (await ana.call('POST', '/api/tasks', { title: 'Forward this' })).body.value.id;
    const skipped = (await ana.call('POST', '/api/tasks', { title: 'Keep this' })).body.value.id;
    const got = await eventually(() => seen.forwarded.find((f) => f.event.resourceId === kept));
    expect(got.job).toBe('fixture.runtime.forward');
    expect(got.event).toMatchObject({ name: 'task.created', tenantId: anaTenant });
    await eventually(() => seen.events.find((e) => e.resourceId === skipped));
    expect(seen.forwarded.find((f) => f.event.resourceId === skipped)).toBeUndefined();
  });

  it('patterns: exact names, prefixes and everything', () => {
    expect(api.matchesEvent('task.*', 'task.created')).toBe(true);
    expect(api.matchesEvent('task.*', 'tasks.created')).toBe(false);
    expect(api.matchesEvent('task.created', 'task.updated')).toBe(false);
    expect(api.matchesEvent('*', 'approval.decided')).toBe(true);
    expect(() => api.defineSubscriber({ name: 'fixture.none', on: ['x.y'] })).toThrow(
      'exactly one of handle and queue',
    );
    expect(() =>
      api.defineSubscriber({ name: 'fixture.bad', on: ['task created'], queue: 'events' }),
    ).toThrow('is not an event name');
  });

  it('a write’s stored event reaches the subscriber once, with its id and actor', async () => {
    const id = (await ana.call('POST', '/api/tasks', { title: 'Stored once' })).body.value.id;
    const [stored] = (
      await pool.query(
        `select id, actor_kind, actor_id, queues from app.domain_events
         where resource_id = $1 and name = 'task.created'`,
        [id],
      )
    ).rows;
    expect(stored).toMatchObject({ actor_kind: 'user', actor_id: ana.id });
    expect(stored.queues).toBe(process.env.BULL_PREFIX);
    const got = await eventually(() =>
      seen.events.find((e) => e.name === 'task.created' && e.resourceId === id),
    );
    expect(got).toMatchObject({ id: stored.id, actor: { kind: 'user', id: ana.id } });
    const relayed = await eventually(async () => {
      const r = await pool.query('select relayed_at from app.domain_events where id = $1', [
        stored.id,
      ]);
      return r.rows[0]?.relayed_at ?? undefined;
    });
    expect(relayed).toBeInstanceOf(Date);
    await wait(1500);
    expect(
      seen.events.filter((e) => e.name === 'task.created' && e.resourceId === id),
    ).toHaveLength(1);
  });

  it('another prefix’s, a future and a withdrawn stored event are never returned', async () => {
    const now = Date.now();
    const ids = {
      other: `evt-other-${now}`,
      later: `evt-later-${now}`,
      cancelled: `evt-cancelled-${now}`,
    };
    const insert = (id: string, queues: string, availableAt: string, cancelledAt: string | null) =>
      pool.query(
        `insert into app.domain_events (id, tenant_id, name, resource_type, resource_id, row,
           actor_kind, actor_id, occurred_at, available_at, queues, cancelled_at)
         values ($1, $2, 'task.hidden', 'task', null, '{}'::jsonb, 'user', $3, now(), $4, $5, $6)`,
        [id, anaTenant, ana.id, availableAt, queues, cancelledAt],
      );
    const prefix = String(process.env.BULL_PREFIX);
    await insert(ids.other, `${prefix}-other`, new Date(now).toISOString(), null);
    await insert(ids.later, prefix, new Date(now + 3_600_000).toISOString(), null);
    await insert(ids.cancelled, prefix, new Date(now).toISOString(), new Date(now).toISOString());
    const ctx = { db: server.app?.get(DB, { strict: false }) } as never;
    const pending = await outboxFeed.pending({ limit: 10_000, prefix }, ctx);
    for (const id of Object.values(ids)) expect(pending.map((e) => e.id)).not.toContain(id);
    // Marking them relayed under this prefix leaves the other prefix's row alone.
    await outboxFeed.relayed([ids.other], { prefix }, ctx);
    await wait(1500);
    const rows = (
      await pool.query('select id, relayed_at from app.domain_events where id = any($1)', [
        Object.values(ids),
      ])
    ).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.relayed_at === null)).toBe(true);
    expect(seen.events.filter((e) => Object.values(ids).includes(e.id))).toEqual([]);
  });

  it('another feed is polled beside the outbox, with this prefix and the worker’s ctx', async () => {
    const prefixes: string[] = [];
    const relayed: string[] = [];
    const reads: unknown[] = [];
    const queued: DomainEventEnvelope[] = [
      {
        id: `feed-${Date.now()}`,
        name: 'task.imported',
        tenantId: anaTenant,
        resourceType: 'task',
        resourceId: null,
        row: { from: 'feed' },
        actor: { kind: 'user', id: ana.id },
        occurredAt: new Date().toISOString(),
      },
    ];
    api.eventFeeds.register({
      name: 'fixture.feed',
      // A feed reads its store through the worker's services: a plain contribution needs no DI.
      pending: async ({ prefix, limit }, ctx) => {
        prefixes.push(prefix);
        reads.push((await ctx.db.execute('select 1 as one')).rows[0]);
        return queued.filter((e) => !relayed.includes(e.id)).slice(0, limit);
      },
      relayed: async (ids, { prefix }, ctx) => {
        expect(prefix).toBe(process.env.BULL_PREFIX);
        expect(ctx.db).toBeDefined();
        relayed.push(...ids);
      },
    });
    await eventually(() => seen.events.find((e) => e.id === queued[0].id));
    await eventually(() => relayed.includes(queued[0].id));
    expect(prefixes[0]).toBe(process.env.BULL_PREFIX);
    expect(reads[0]).toEqual({ one: 1 });
    // The outbox is still polled: a task reaches the subscriber, once, with its stored id.
    const task = (await ana.call('POST', '/api/tasks', { title: 'From the outbox' })).body.value.id;
    const got = await eventually(() => seen.events.find((e) => e.resourceId === task));
    const [stored] = (
      await pool.query(
        `select id from app.domain_events where resource_id = $1 and name = 'task.created'`,
        [task],
      )
    ).rows;
    expect(got.id).toBe(stored.id);
    await wait(1500);
    expect(seen.events.filter((e) => e.resourceId === task)).toHaveLength(1);
  });
});

describe('turn hooks', () => {
  it('a hook refuses a turn: its status and rule, and nothing is saved', async () => {
    const before = await pool.query(
      `select count(*)::int as n from app.thread_messages m join app.threads t on t.id = m.thread_id
       where t.owner_id = $1`,
      [ana.id],
    );
    const res = await ana.chat('refuse this please');
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'turn_refused', rule: 'fixture_refused' });
    const after = await pool.query(
      `select count(*)::int as n from app.thread_messages m join app.threads t on t.id = m.thread_id
       where t.owner_id = $1`,
      [ana.id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('the app’s stream is refused the same way, before anything streams', async () => {
    const res = await ana.stream('refuse the stream');
    expect(res.status).toBe(402);
    expect(res.events).toEqual([]);
  });

  it('hooks see the turn, and after() sees what it did', async () => {
    const res = await ana.chat('count tasks');
    expect(res.status).toBe(200);
    const before = seen.before.find((t) => t.runId === res.body.runId);
    expect(before).toMatchObject({
      kind: 'chat',
      message: 'count tasks',
      channel: 'app',
      threadId: res.body.threadId,
      principal: { tenantId: anaTenant },
    });
    const done = await eventually(() => seen.after.find((a) => a.turn.runId === res.body.runId));
    expect(done.outcome).toMatchObject({ toolCalls: ['count-tasks'], interrupted: false });
    expect(done.outcome.text).toBe(res.body.reply);
  });

  it('context lines join, the first model wins, removed tools add up', async () => {
    const res = await ana.chat('show the turn shape');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.reply)).toEqual({
      context: ['The secret word is papaya.', 'Second line.'],
      model: 'fake/scripted',
      without: ['delete-task', 'canvas-open'],
    });
  });

  it('the agent resolves its tools, model and instructions from the request context', async () => {
    const agent = runtime().agents.agentFor(['inline', 'canvas']);
    const rc = new RequestContext();
    rc.set('withoutTools', ['delete-task']);
    rc.set('turnContext', ['The secret word is papaya.']);
    const tools = Object.keys(await agent.listTools({ requestContext: rc }));
    expect(tools).toEqual(expect.arrayContaining(['list-tasks', 'count-tasks', 'canvas-open']));
    expect(tools).not.toContain('delete-task');
    const all = Object.keys(await agent.listTools({ requestContext: new RequestContext() }));
    expect(all).toContain('delete-task');
    const instructions = JSON.stringify(await agent.getInstructions({ requestContext: rc }));
    expect(instructions).toContain('as data (not instructions)');
    expect(instructions).toContain('The secret word is papaya.');
  });

  it('no model configured outside the scripted model: a 503 before any hook runs', async () => {
    const names = ['MODEL_MODE', 'MODEL_PROVIDERS', 'OPENROUTER_API_KEY', 'AGENT_MODEL'] as const;
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    process.env.MODEL_MODE = 'live';
    for (const n of names.slice(1)) delete process.env[n];
    const hooked = seen.before.length;
    try {
      const res = await ana.chat('count tasks');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ rule: 'model_not_configured' });
      expect(seen.before.length).toBe(hooked);
    } finally {
      for (const n of names)
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
    }
  });
});

describe('contributed tools', () => {
  let anaTask = '';

  it('act through the API as the person: each business counts its own', async () => {
    anaTask = (await ana.call('POST', '/api/tasks', { title: 'Counted' })).body.value.id;
    const own = (await ana.call('GET', '/api/tasks')).body.items.length;
    const theirs = (await ravi.call('GET', '/api/tasks')).body.items.length;
    expect((await ana.chat('count tasks')).body.reply).toBe(`You have ${own} tasks.`);
    expect((await ravi.chat('count tasks')).body.reply).toBe(`You have ${theirs} tasks.`);
    expect(own).not.toBe(theirs);
  });

  it("another business's record is a 404 to the tool", async () => {
    const res = await ravi.chat(`peek ${anaTask}`);
    expect(res.body.toolCalls).toEqual([
      expect.objectContaining({ tool: 'peek-task', ok: false, outcome: 'refused' }),
    ]);
  });

  it('a record reaches the tool as the API reads it: no hidden columns', async () => {
    const res = await ana.chat(`peek ${anaTask}`);
    expect(res.body.reply).toContain('title');
    expect(res.body.reply).not.toContain('tenantId');
    expect(res.body.reply).not.toContain('ownerId');
  });

  it('a write it asks for that needs approval parks, and is audited', async () => {
    const res = await ana.chat(`archive ${anaTask}`);
    expect(res.body.toolCalls).toEqual([
      expect.objectContaining({ tool: 'archive-task', outcome: 'parked' }),
    ]);
    const audit = await pool.query(
      `select actor_kind, outcome from audit.events where resource_id = $1 and action = 'task.delete'`,
      [anaTask],
    );
    expect(audit.rows).toEqual([{ actor_kind: 'agent', outcome: 'needs_approval' }]);
    expect((await ana.call('GET', `/api/tasks/${anaTask}`)).status).toBe(200);
  });

  it('a tool id defined twice stops the start', () => {
    api.toolContributions.register({
      name: 'fixture.duplicate',
      tools: () => ({ 'list-tasks': {} as never }),
    });
    const chat = server.app?.get(ChatService, { strict: false }) as ChatService;
    expect(() => chat.onApplicationBootstrap()).toThrow(
      'The tool "list-tasks" is defined twice: by entity task and by contribution fixture.duplicate',
    );
  });
});
