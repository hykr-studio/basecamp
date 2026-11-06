// The runtime registries (F5): queues and schedules from the registry, subscribers to committed
// events, turn hooks, the agent's per-turn model, tools and instructions, and contributed tools
// that act through the API as the person. The fixture's features/runtime contributes one of each.
import type { DomainEventEnvelope } from '@hykr/contracts';
import { RequestContext } from '@mastra/core/request-context';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventRelay } from '../../dist/features/events/relay.service.js';
import * as api from '../../dist/index.js';
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
    const created = await ana.call('POST', '/api/tasks', { title: 'Order tiles' });
    const id = created.body.value.id;
    const event = await eventually(() =>
      seen.events.find((e) => e.name === 'task.created' && e.resourceId === id),
    );
    expect(event).toMatchObject({
      tenantId: anaTenant,
      resourceType: 'task',
      row: { id, title: 'Order tiles', tenantId: anaTenant },
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

  it('an event without a business is never relayed', () => {
    expect(api.envelopeOf({ eventName: 'task.created', row: { id: 'x' } })).toBeUndefined();
    expect(
      api.envelopeOf({ eventName: 'task.created', row: { id: 'x', tenantId: 't1' } }),
    ).toMatchObject({ tenantId: 't1', resourceType: 'task', resourceId: 'x' });
  });

  it('a durable feed is polled with this prefix, and the bus goes quiet while it exists', async () => {
    const prefixes: string[] = [];
    const relayed: string[] = [];
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
      pending: async ({ prefix, limit }) => {
        prefixes.push(prefix);
        return queued.filter((e) => !relayed.includes(e.id)).slice(0, limit);
      },
      relayed: async (ids) => {
        relayed.push(...ids);
      },
    });
    await eventually(() => seen.events.find((e) => e.id === queued[0].id));
    await eventually(() => relayed.includes(queued[0].id));
    expect(prefixes[0]).toBe(process.env.BULL_PREFIX);
    // The bus is not relayed any more: the feed would carry it.
    const quiet = (await ana.call('POST', '/api/tasks', { title: 'Not from the bus' })).body.value
      .id;
    await wait(1500);
    expect(seen.events.find((e) => e.resourceId === quiet)).toBeUndefined();
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
      model: 'openrouter/fixture/first',
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
    const { modelFor } = await import('@hykr/agents');
    const named = new RequestContext();
    named.set('model', 'openrouter/fixture/first');
    expect(modelFor({ requestContext: named })).toBe('openrouter/fixture/first');
    expect(modelFor({ requestContext: new RequestContext() })).toBe(
      process.env.AGENT_MODEL ?? 'openrouter/openai/gpt-6-luna',
    );
  });

  it('the framework’s own hook: no model key outside the scripted model is a 503', async () => {
    const saved = { mode: process.env.MODEL_MODE, key: process.env.OPENROUTER_API_KEY };
    process.env.MODEL_MODE = 'live';
    delete process.env.OPENROUTER_API_KEY;
    try {
      const res = await ana.chat('count tasks');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ rule: 'model_not_configured' });
    } finally {
      process.env.MODEL_MODE = saved.mode;
      if (saved.key !== undefined) process.env.OPENROUTER_API_KEY = saved.key;
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
