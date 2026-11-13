// Agents a business makes (A6): definitions, runs that act for their owner with a run token and
// never beyond them, the triggers, budgets and the run log. The worker runs inline: the outbox,
// the relay, the agents' queues and Mastra's storage are the real ones.
import { randomUUID } from 'node:crypto';
import { type LiveMessage, liveMessages, textOf } from '@hykr/api-client';
import { signWebhook } from '@hykr/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Connections keep their credentials sealed with it; set before the app reads its configuration.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';

import {
  agentRunToken,
  eraseWithContributors,
  exportPersonalData,
  inboundHooks,
} from '../../dist/index.js';
import {
  addMember,
  boot,
  eventually,
  me,
  origin,
  Person,
  pool,
  runtime,
  server,
  shutdown,
} from '../../dist/testing.js';
import { agentsApp } from '../fixture/dist/features/agents/index.js';

const ana = new Person('Ana Agents'); // owner of the business: agents.create and agents.manage
const sam = new Person('Sam Agents'); // staff: neither
const rex = new Person('Rex Agents'); // fixture_runner: agents.create, every project, no cost
const bob = new Person('Bob Agents'); // another business
let tenantId = '';

const inA = () => ({ 'x-tenant-id': tenantId });
type Clock = {
  tick(now?: Date): Promise<unknown>;
  onInbound(msg: unknown): Promise<number>;
  identify(req: {
    method: string;
    path: string;
    headers: Record<string, string>;
  }): Promise<{ scopes?: readonly string[]; narrowing?: readonly string[] } | null>;
};
let svc: () => Clock;

type Run = {
  id: string;
  agentId: string;
  runId: string;
  status: string;
  reason: string | null;
  reply: string | null;
  toolCalls: { tool: string; outcome: string; approvalId?: string }[];
  trigger: { kind: string; label: string };
  depth: number;
  agentVersion: string | null;
};

async function agent(who: Person, body: Record<string, unknown>) {
  const res = await who.call('POST', '/api/agents', body, inA());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.value as { id: string; ownerId: string; status: string; triggers: unknown[] };
}

async function task(who: Person, title: string, more: Record<string, unknown> = {}) {
  const res = await who.call('POST', '/api/tasks', { title, ...more }, inA());
  expect(res.status).toBe(201);
  return res.body.value as { id: string; title: string };
}

/** Run now; the queued run's id. */
async function runNow(who: Person, agentId: string, note?: string) {
  const res = await who.call('POST', `/api/agents/${agentId}/run`, note ? { note } : {}, inA());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.value.id as string;
}

/** A run as its log shows it, once it is no longer queued or running. */
async function settled(
  who: Person,
  id: string,
  statuses = ['done', 'waiting', 'failed', 'refused'],
) {
  return eventually(async () => {
    const res = await who.call('GET', `/api/agent-runs/${id}`, undefined, inA());
    return statuses.includes(res.body?.status)
      ? (res.body as Run & { messages: unknown[] })
      : undefined;
  }, 20_000);
}

/** Every run of an agent, oldest first (straight from the table). */
const runsOf = async (agentId: string) =>
  (
    await pool.query(
      'select id, status, trigger_kind, depth, reason from app.agent_runs where agent_id = $1 order by created_at',
      [agentId],
    )
  ).rows as { id: string; status: string; trigger_kind: string; depth: number; reason: string }[];

/** A request with a run's token, as the run's tools make them. */
async function asRun(runId: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-agent-run': token ?? agentRunToken(runId),
      'x-run-id': runId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A run row of this agent, running, made by hand: what its token reaches. */
async function runningRun(agentId: string) {
  const runId = randomUUID().replaceAll('-', '');
  await pool.query(
    `insert into app.agent_runs (tenant_id, agent_id, run_id, trigger_kind, dedupe, status, queues)
     values ($1, $2, $3, 'manual', $4, 'running', 'test-none')`,
    [tenantId, agentId, runId, `test:${runId}`],
  );
  return runId;
}

async function live(who: Person) {
  const controller = new AbortController();
  const res = await fetch(`${server.base}/api/live`, {
    headers: { origin, cookie: who.cookie, 'x-tenant-id': tenantId },
    signal: controller.signal,
  });
  const got: LiveMessage[] = [];
  void (async () => {
    try {
      for await (const m of liveMessages(textOf(res.body as ReadableStream<Uint8Array>)))
        got.push(m);
    } catch {
      // closed
    }
  })();
  await eventually(() => got.find((m) => m.kind === 'ready'));
  const events = () => got.flatMap((m) => (m.kind === 'change' ? [m.event] : []));
  return { events, close: () => controller.abort() };
}

beforeAll(async () => {
  await boot(agentsApp);
  // Loaded after boot: it reads the server's configuration.
  const { AgentsService } = await import('../../dist/testing-internals.js');
  svc = () => server.app?.get(AgentsService, { strict: false }) as unknown as Clock;
  for (const p of [ana, sam, rex, bob]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  await addMember(sam, tenantId, ['staff']);
  await addMember(rex, tenantId, ['fixture_runner']);
}, 120_000);
afterAll(shutdown);

describe('definitions', () => {
  it('making one needs agents.create; the owner and the managers see it, nobody else', async () => {
    const refused = await sam.call(
      'POST',
      '/api/agents',
      { name: 'Mine', instructions: 'Count my open tasks.' },
      inA(),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('agents_create');
    const made = await agent(rex, { name: 'Rex counts', instructions: 'Count my open tasks.' });
    expect(made).toMatchObject({ ownerId: rex.id, status: 'active', triggers: [] });
    expect((await sam.call('GET', `/api/agents/${made.id}`, undefined, inA())).status).toBe(404);
    expect((await bob.call('GET', `/api/agents/${made.id}`)).status).toBe(404);
    // Ana manages the business's agents: she sees Rex's.
    expect((await ana.call('GET', `/api/agents/${made.id}`, undefined, inA())).status).toBe(200);
    const anas = await agent(ana, { name: 'Ana counts', instructions: 'Count my open tasks.' });
    const rexSees = (await rex.call('GET', '/api/agents', undefined, inA())).body.items.map(
      (a: { id: string }) => a.id,
    );
    expect(rexSees).toContain(made.id);
    expect(rexSees).not.toContain(anas.id);
  });

  it('a manager pauses and resumes anyone’s agent, but only its owner changes what it does', async () => {
    const made = await agent(rex, { name: 'Rex two', instructions: 'Count my open tasks.' });
    const edit = await ana.call('PATCH', `/api/agents/${made.id}`, { name: 'Mine now' }, inA());
    expect(edit.status).toBe(403);
    expect(edit.body.rule).toBe('agent_not_yours');
    const paused = await ana.call('PATCH', `/api/agents/${made.id}`, { status: 'paused' }, inA());
    expect(paused.body.value).toMatchObject({ status: 'paused', name: 'Rex two' });
    const renamed = await rex.call('PATCH', `/api/agents/${made.id}`, { name: 'Rex 2' }, inA());
    expect(renamed.body.value.name).toBe('Rex 2');
  });

  it('a definition is checked against the server: every problem is listed', async () => {
    const res = await ana.call(
      'POST',
      '/api/agents',
      {
        name: 'Bad',
        instructions: 'Count my open tasks.',
        triggers: [
          { kind: 'recurring', cron: '* * * * *' },
          { kind: 'recurring', cron: '0 9 * * 1', timeZone: 'Mars/Olympus' },
          { kind: 'condition', entity: 'visit', where: { title: 'x' } },
          { kind: 'condition', entity: 'nothing', where: {} },
          { kind: 'webhook', connectionId: randomUUID() },
          { kind: 'once', at: '2001-01-01T00:00:00Z' },
        ],
        scope: { tools: ['list-tasks', 'list-nothing', 'create-agent', 'canvas-open'] },
        template: 'bots.missing',
      },
      inA(),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_agent');
    const problems = (res.body.problems as string[]).join('\n');
    for (const said of [
      'runs more often than every 5 minutes',
      '"Mars/Olympus" is not a time zone',
      'the scope has no tool that reads visits',
      'there is no entity nothing',
      'there is no connection',
      'is in the past',
      'there is no tool list-nothing',
      'create-agent manages agents',
      'canvas-open manages agents or the canvas',
      'there is no agent template bots.missing',
    ])
      expect(problems).toContain(said);
    // Nothing was written.
    const { rows } = await pool.query("select 1 from app.agents where name = 'Bad'");
    expect(rows).toEqual([]);
    // Reading customers' messages needs the back office: Rex works without it.
    const inbound = await rex.call(
      'POST',
      '/api/agents',
      {
        name: 'Listen',
        instructions: 'Report what started this run.',
        triggers: [{ kind: 'message' }],
      },
      inA(),
    );
    expect(inbound.status).toBe(400);
    expect(inbound.body.message).toContain('back office');
  });

  it('the assistant drafts an agent from one line; approving it makes it the person’s', async () => {
    const chat = await ana.chat(
      'create an agent to count my open tasks every monday using list-tasks',
    );
    expect(chat.status).toBe(200);
    const parked = chat.body.toolCalls.find((c: { tool: string }) => c.tool === 'create-agent');
    expect(parked).toMatchObject({ outcome: 'parked', approvalId: expect.any(String) });
    const approved = await ana.call(
      'POST',
      `/api/approvals/${parked.approvalId}/approve`,
      undefined,
      inA(),
    );
    expect(approved.body.status).toBe('approved');
    const { rows } = await pool.query(
      `select owner_id, created_by, triggers, scope from app.agents
        where tenant_id = $1 and name = 'Count my open tasks'`,
      [tenantId],
    );
    expect(rows).toEqual([
      {
        owner_id: ana.id,
        created_by: 'assistant',
        triggers: [{ kind: 'recurring', cron: '0 9 * * 1' }],
        scope: { tools: ['list-tasks'] },
      },
    ]);
  });

  it('the application’s templates are listed, with whether this server can make them', async () => {
    const { items, tools } = (await ana.call('GET', '/api/agent-templates', undefined, inA())).body;
    expect(tools).toEqual(expect.arrayContaining(['list-tasks', 'delete-task', 'list-comments']));
    expect(tools).not.toContain('create-agent');
    expect(tools).not.toContain('canvas-open');
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'bots.count-tasks',
          name: 'Monday tasks',
          available: true,
          budget: { period: 'week', runs: 5, maxSteps: 6 },
        }),
        expect.objectContaining({ key: 'bots.unavailable', available: false }),
      ]),
    );
  });
});

describe('a run', () => {
  it('runs now: logged, in the agent’s own thread, never the person’s conversation', async () => {
    await task(ana, 'Paint the door');
    await task(ana, 'Fix the tap');
    const counter = await agent(ana, {
      name: 'Counter',
      instructions: 'Count my open tasks.',
      scope: { tools: ['list-tasks'] },
    });
    const run = await settled(ana, await runNow(ana, counter.id));
    expect(run.status).toBe('done');
    expect(run.reply).toMatch(/^\d+ open tasks: .*Paint the door.*Fix the tap/);
    expect(run.trigger).toEqual({ kind: 'manual', label: 'run now' });
    expect(run.toolCalls).toEqual([
      expect.objectContaining({ tool: 'list-tasks', outcome: 'done' }),
    ]);
    expect(run.agentVersion).toMatch(new RegExp(`^agent:${counter.id}@.+#[0-9a-f]{8}$`));
    expect(run.messages).toHaveLength(2);
    const { rows } = await pool.query(
      `select t.kind, t.agent_id, t.owner_id from app.thread_messages m
         join app.threads t on t.id = m.thread_id where m.run_id = $1`,
      [run.runId],
    );
    expect(rows[0]).toEqual({ kind: 'agent', agent_id: counter.id, owner_id: ana.id });
    const current = (await ana.call('GET', '/api/threads/current', undefined, inA())).body.id;
    const mine = (await ana.call('GET', `/api/threads/${current}/messages`, undefined, inA())).body;
    expect(mine.some((m: { metadata: { runId: string } }) => m.metadata.runId === run.runId)).toBe(
      false,
    );
  });

  it('never does more than its owner: a record they cannot read is not there', async () => {
    const anas = await task(ana, 'Only for Ana');
    const reader = await agent(rex, {
      name: 'Reader',
      instructions: 'Read the task in the data.',
      scope: { tools: ['get-task'] },
    });
    const run = await settled(rex, await runNow(rex, reader.id, anas.id));
    // The API answered 404, as it does to Rex himself.
    expect(run.reply).toBe("I couldn't do that: No such task.");
    expect((await rex.call('GET', `/api/tasks/${anas.id}`, undefined, inA())).status).toBe(404);
  });

  it('a manager runs anyone’s agent, but only its owner gives the run a note', async () => {
    const anas = await task(ana, 'Ana’s own, for the note');
    const reader = await agent(rex, {
      name: 'Rex reader',
      instructions: 'Read the task in the data.',
      scope: { tools: ['get-task'] },
    });
    // Ana manages the business's agents, but her words never steer a run that acts as Rex.
    const steered = await ana.call(
      'POST',
      `/api/agents/${reader.id}/run`,
      { note: anas.id },
      inA(),
    );
    expect(steered).toMatchObject({ status: 403, body: { rule: 'agent_note_owner_only' } });
    expect(await runsOf(reader.id)).toEqual([]);
    const { rows } = await pool.query(
      `select outcome, rule from audit.events
        where action = 'agent.run' and resource_id = $1 and actor_id = $2`,
      [reader.id, ana.id],
    );
    expect(rows).toEqual([{ outcome: 'denied', rule: 'agent_note_owner_only' }]);
    // Without a note it runs, as Rex; Rex's own note is his to give.
    expect((await settled(ana, await runNow(ana, reader.id))).status).toBe('done');
    const own = await settled(rex, await runNow(rex, reader.id, randomUUID()));
    expect(own.reply).toBe("I couldn't do that: No such task.");
  });

  it('its token reaches its scope only, as its owner, and nothing after the run', async () => {
    const anas = await task(ana, 'Token target');
    const scoped = await agent(ana, {
      name: 'Scoped',
      instructions: 'Read the task in the data.',
      scope: { tools: ['get-task'] },
    });
    const runId = await runningRun(scoped.id);
    // Its limits are the feature's own narrowing, not route scopes: no route-scope check applies.
    const identity = await svc().identify({
      method: 'GET',
      path: `/api/tasks/${anas.id}`,
      headers: { 'x-agent-run': agentRunToken(runId), 'x-run-id': runId },
    });
    expect(identity?.scopes).toBeUndefined();
    expect(identity?.narrowing).toEqual(
      expect.arrayContaining(['agent-run', 'agent-run.read:task']),
    );
    expect((await asRun(runId, 'GET', `/api/tasks/${anas.id}`)).status).toBe(200);
    // Not in its scope: a read of another entity, a write.
    const visits = await asRun(runId, 'GET', '/api/visits');
    expect(visits).toMatchObject({ status: 403, body: { rule: 'agent_scope' } });
    const write = await asRun(runId, 'POST', '/api/tasks', { title: 'Sneaky' });
    expect(write).toMatchObject({ status: 403, body: { rule: 'agent_scope' } });
    const { rows } = await pool.query(
      `select outcome, actor_kind, actor_id, channel from audit.events
        where run_id = $1 and action = 'task.create'`,
      [runId],
    );
    expect(rows).toEqual([
      {
        outcome: 'denied',
        actor_kind: 'agent',
        actor_id: `agent:${scoped.id}`,
        channel: 'background',
      },
    ]);
    // Agents are never in reach of a run, nor the run log.
    expect((await asRun(runId, 'GET', '/api/agents')).status).toBe(403);
    expect((await asRun(runId, 'GET', '/api/agent-runs')).status).toBe(403);
    // Another business named in the header: refused.
    const other = (await me(bob)).tenantId;
    const res = await fetch(`${server.base}/api/tasks/${anas.id}`, {
      headers: { 'x-agent-run': agentRunToken(runId), 'x-run-id': runId, 'x-tenant-id': other },
    });
    expect(res.status).toBe(403);
    // A forged token, and a run that is over.
    expect(
      (await asRun(runId, 'GET', `/api/tasks/${anas.id}`, undefined, 'f'.repeat(64))).status,
    ).toBe(401);
    await pool.query(`update app.agent_runs set status = 'done' where run_id = $1`, [runId]);
    expect((await asRun(runId, 'GET', `/api/tasks/${anas.id}`)).status).toBe(401);
  });

  it('a write that waits: the owner decides it, and the run goes on under the same run', async () => {
    const target = await task(ana, 'Old note');
    const tidy = await agent(ana, {
      name: 'Tidier',
      instructions: 'Tidy the task in the data.',
      scope: { tools: ['delete-task', 'create-task'] },
    });
    const run = await settled(ana, await runNow(ana, tidy.id, target.id));
    expect(run.status).toBe('waiting');
    const parked = run.toolCalls.find((c) => c.tool === 'delete-task');
    expect(parked).toMatchObject({ outcome: 'parked', approvalId: expect.any(String) });
    const before = await pool.query(
      `select outcome, actor_id, channel, agent_version, acting_for from audit.events
        where run_id = $1 and action = 'task.delete'`,
      [run.runId],
    );
    expect(before.rows).toEqual([
      expect.objectContaining({
        outcome: 'needs_approval',
        actor_id: `agent:${tidy.id}`,
        channel: 'background',
        agent_version: run.agentVersion,
        acting_for: ana.id,
      }),
    ]);
    // It is Ana's to decide, as her own assistant's request is.
    const pending = (await ana.call('GET', '/api/approvals', undefined, inA())).body;
    expect(JSON.stringify(pending)).toContain(parked?.approvalId);
    await ana.call('POST', `/api/approvals/${parked?.approvalId}/approve`, undefined, inA());
    const done = await settled(ana, run.id, ['done', 'failed', 'refused']);
    expect(done.status).toBe('done');
    expect(done.reply).toBe(`Tidied ${target.id}.`);
    expect((await ana.call('GET', `/api/tasks/${target.id}`, undefined, inA())).status).toBe(404);
    const after = await pool.query(
      `select action, outcome, actor_id from audit.events
        where run_id = $1 and action like 'task.%' order by at, action`,
      [run.runId],
    );
    expect(after.rows.map((r) => `${r.action}/${r.outcome}/${r.actor_id}`)).toEqual([
      `task.delete/needs_approval/agent:${tidy.id}`,
      `task.delete/committed/agent:${tidy.id}`,
      `task.create/committed/agent:${tidy.id}`,
    ]);
  });

  it('two writes that wait: after the first decision it is waiting again, never stale', async () => {
    const piles = [await task(ana, 'First pile'), await task(ana, 'Second pile')];
    const both = await agent(ana, {
      name: 'Both tidier',
      instructions: 'Tidy both tasks in the data.',
      scope: { tools: ['delete-task'] },
    });
    const run = await settled(ana, await runNow(ana, both.id, piles.map((t) => t.id).join(' ')));
    expect(run.status).toBe('waiting');
    const parked = run.toolCalls.filter((c) => c.tool === 'delete-task');
    expect(parked.map((c) => c.outcome)).toEqual(['parked', 'parked']);
    const [first, second] = parked.map((c) => c.approvalId as string);

    const left = async () =>
      (
        await Promise.all(
          piles.map(
            async (t) => (await ana.call('GET', `/api/tasks/${t.id}`, undefined, inA())).status,
          ),
        )
      ).filter((s) => s === 200).length;

    // The first decision (either task: the calls park in no set order): the run resumes, says
    // nothing new (the other still waits), and is waiting again, not left running.
    const approved = await ana.call('POST', `/api/approvals/${first}/approve`, undefined, inA());
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await eventually(
      async () =>
        (await runtime().agents.findSuspension({ runId: run.runId, approvalId: first }))
          ? undefined
          : true,
      20_000,
    );
    const between = await eventually(async () => {
      const res = await ana.call('GET', `/api/agent-runs/${run.id}`, undefined, inA());
      return res.body?.status === 'waiting' ? (res.body as Run) : undefined;
    }, 20_000);
    expect(between.reason).not.toBe('The run stopped without finishing');
    expect(await left()).toBe(1);
    // Long after (the clock fails a run `running` for 15 minutes): still waiting.
    await pool.query(
      `update app.agent_runs set updated_at = now() - interval '1 hour' where id = $1`,
      [run.id],
    );
    await svc().tick();
    expect((await runsOf(both.id)).map((r) => r.status)).toEqual(['waiting']);

    // The second decision: the run goes on once, and is done.
    const next = await ana.call('POST', `/api/approvals/${second}/approve`, undefined, inA());
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    const done = await settled(ana, run.id, ['done', 'failed', 'refused']);
    expect(done.status).toBe('done');
    expect(done.reply).toBe('Both decided: approved and approved.');
    expect(await left()).toBe(0);
  });

  it('refused: a paused agent, a used-up budget, an owner who left', async () => {
    const once = await agent(ana, {
      name: 'Once a day',
      instructions: 'Count my open tasks.',
      scope: { tools: ['list-tasks'] },
      budget: { period: 'day', runs: 1 },
    });
    expect((await settled(ana, await runNow(ana, once.id))).status).toBe('done');
    const second = await settled(ana, await runNow(ana, once.id));
    expect(second).toMatchObject({ status: 'refused' });
    expect(second.reason).toMatch(/^agent_budget_exhausted: This agent has used 1 of its 1 runs/);
    // Tokens too: the scripted model reports what each run used.
    const thrifty = await agent(ana, {
      name: 'Thrifty',
      instructions: 'Count my open tasks.',
      scope: { tools: ['list-tasks'] },
      budget: { period: 'month', tokens: 1 },
    });
    expect((await settled(ana, await runNow(ana, thrifty.id))).status).toBe('done');
    const over = await settled(ana, await runNow(ana, thrifty.id));
    expect(over.reason).toMatch(/^agent_budget_exhausted: This agent has used \d+ of its 1 tokens/);
    await ana.call('PATCH', `/api/agents/${once.id}`, { status: 'paused' }, inA());
    const paused = await ana.call('POST', `/api/agents/${once.id}/run`, {}, inA());
    expect(paused).toMatchObject({ status: 403, body: { rule: 'agent_paused' } });

    const leaver = new Person('Lee Agents');
    await leaver.signUp();
    await addMember(leaver, tenantId, ['fixture_runner']);
    const theirs = await agent(leaver, {
      name: 'Left behind',
      instructions: 'Count my open tasks.',
    });
    await pool.query('delete from app.memberships where tenant_id = $1 and user_id = $2', [
      tenantId,
      leaver.id,
    ]);
    const left = await settled(ana, await runNow(ana, theirs.id));
    expect(left.status).toBe('refused');
    expect(left.reason).toMatch(/^owner_not_member/);
  });
});

describe('triggers', () => {
  it('a schedule and a time fire through the clock, each once', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const timed = await agent(ana, {
      name: 'Timed',
      instructions: 'Count my open tasks.',
      scope: { tools: ['list-tasks'] },
      triggers: [
        { kind: 'recurring', cron: '0 9 * * 1' },
        { kind: 'once', at },
      ],
    });
    const { rows } = await pool.query(
      'select kind, next_at from app.agent_triggers where agent_id = $1 order by position',
      [timed.id],
    );
    const monday = new Date(rows[0].next_at);
    expect(monday.getUTCDay() === 1 || monday.getUTCDay() === 0).toBe(true);
    expect(new Date(rows[1].next_at).toISOString()).toBe(at);
    await svc().tick(new Date(new Date(at).getTime() + 1000));
    await svc().tick(new Date(Math.max(monday.getTime(), new Date(at).getTime()) + 1000));
    await eventually(async () => {
      const runs = await runsOf(timed.id);
      return runs.filter((r) => r.status === 'done').length === 2 ? runs : undefined;
    }, 20_000);
    const runs = await runsOf(timed.id);
    expect(runs.map((r) => r.trigger_kind).sort()).toEqual(['once', 'recurring']);
    const after = await pool.query(
      'select kind, next_at from app.agent_triggers where agent_id = $1 order by position',
      [timed.id],
    );
    expect(after.rows[1].next_at).toBeNull();
    expect(new Date(after.rows[0].next_at).getTime()).toBeGreaterThan(monday.getTime());
  });

  it('an event: for records the owner reads; never its own run’s; one level deeper for others', async () => {
    const watcher = await agent(ana, {
      name: 'Watcher',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'event', on: ['task.created'], where: { done: false } }],
    });
    // Rex reads no tasks at all: no task event starts his agent.
    const blind = await agent(rex, {
      name: 'Blind',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'event', on: ['task.*'] }],
    });
    // Adds a task for each new one: its own task's event must not start it again.
    const follower = await agent(ana, {
      name: 'Follower',
      instructions: 'Add a follow-up task.',
      scope: { tools: ['create-task'] },
      triggers: [{ kind: 'event', on: ['task.created'] }],
    });
    try {
      const seen = await task(ana, 'Ana sees');
      const followed = await eventually(async () => {
        const { rows } = await pool.query(
          "select id from app.fixture_tasks where tenant_id = $1 and title = 'Follow up Ana sees'",
          [tenantId],
        );
        return rows[0]?.id as string | undefined;
      }, 20_000);
      const runs = await eventually(async () => {
        const all = await runsOf(watcher.id);
        return all.filter((r) => r.status === 'done').length >= 2 ? all : undefined;
      }, 20_000);
      const replies = await Promise.all(
        runs.map(async (r) => (await settled(ana, r.id)).reply ?? ''),
      );
      const first = replies.findIndex((r) => r.includes(`"id":"${seen.id}"`));
      const second = replies.findIndex((r) => r.includes(`"id":"${followed}"`));
      expect(replies[first]).toContain('"title":"Ana sees"');
      // The follow-up was the Follower's run's: one level deeper.
      expect(runs[first].depth).toBe(0);
      expect(runs[second].depth).toBe(1);
      expect((await settled(ana, runs[first].id)).trigger).toEqual({
        kind: 'event',
        label: 'on task.created',
      });
      await new Promise((r) => setTimeout(r, 1500));
      expect((await runsOf(follower.id)).length).toBe(1);
      expect(await runsOf(blind.id)).toEqual([]);
    } finally {
      for (const [who, a] of [
        [ana, watcher],
        [rex, blind],
        [ana, follower],
      ] as const)
        await who.call('PATCH', `/api/agents/${a.id}`, { status: 'paused' }, inA());
    }
  });

  it('an event that happened before the trigger was saved starts no run; a later one does', async () => {
    const t = await task(ana, 'Older than the agent');
    const since = await agent(ana, {
      name: 'Since',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'event', on: ['task.updated'] }],
    });
    try {
      // A stored event of that task from before the agent, relayed only now (held, or late).
      const before = `evt-before-${randomUUID()}`;
      await pool.query(
        `insert into app.domain_events (id, tenant_id, name, resource_type, resource_id, row,
           actor_kind, actor_id, occurred_at, available_at, queues)
         select $1, $2, 'task.updated', 'task', $3, e.row, 'user', $4,
                now() - interval '1 minute', now(), $5
           from app.domain_events e where e.resource_id = $3 and e.name = 'task.created'`,
        [before, tenantId, t.id, ana.id, process.env.BULL_PREFIX],
      );
      const later = await ana.call('PATCH', `/api/tasks/${t.id}`, { title: 'Newer' }, inA());
      expect(later.status).toBe(200);
      const dedupes = async () =>
        (
          await pool.query('select dedupe from app.agent_runs where agent_id = $1', [since.id])
        ).rows.map((r) => r.dedupe as string);
      await eventually(async () => ((await dedupes()).length ? true : undefined), 20_000);
      await eventually(
        async () =>
          (await pool.query('select relayed_at from app.domain_events where id = $1', [before]))
            .rows[0]?.relayed_at ?? undefined,
      );
      await new Promise((r) => setTimeout(r, 1500));
      const all = await dedupes();
      expect(all).toHaveLength(1);
      expect(all).not.toContain(`event:${before}`);
    } finally {
      await ana.call('PATCH', `/api/agents/${since.id}`, { status: 'paused' }, inA());
    }
  });

  it('a record’s fields the owner may not read stay out of the run’s data', async () => {
    const theirs = await agent(rex, {
      name: 'Projects (no cost)',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'event', on: ['project.created'] }],
    });
    const mine = await agent(ana, {
      name: 'Projects (cost)',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'event', on: ['project.created'] }],
    });
    const made = await ana.call('POST', '/api/projects', { title: 'Kitchen', cost: 4242 }, inA());
    expect(made.status).toBe(201);
    const reply = async (agentId: string, who: Person) => {
      const run = await eventually(
        async () => (await runsOf(agentId)).find((r) => r.status === 'done'),
        20_000,
      );
      return (await settled(who, run.id)).reply ?? '';
    };
    const rexs = await reply(theirs.id, rex);
    expect(rexs).toContain('"title":"Kitchen"');
    expect(rexs).not.toContain('4242');
    expect(await reply(mine.id, ana)).toContain('"cost":4242');
  });

  it('a condition: each record that newly matches starts one run', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const late = await task(ana, 'Overdue one', { dueOn: yesterday });
    const watch = await agent(ana, {
      name: 'Overdue',
      instructions: 'Report what started this run.',
      scope: { tools: ['list-tasks'] },
      triggers: [
        {
          kind: 'condition',
          entity: 'task',
          where: { done: false, dueOn: { lt: '$today' }, title: { contains: 'Overdue' } },
          everyMinutes: 5,
        },
      ],
    });
    await svc().tick(new Date(Date.now() + 1000));
    const run = await eventually(
      async () => (await runsOf(watch.id)).find((r) => r.status === 'done'),
      20_000,
    );
    expect((await settled(ana, run.id)).reply).toContain(late.id);
    // Due again later: the same record starts nothing new.
    await pool.query('update app.agent_triggers set next_at = now() where agent_id = $1', [
      watch.id,
    ]);
    await svc().tick(new Date(Date.now() + 1000));
    await new Promise((r) => setTimeout(r, 1000));
    expect(await runsOf(watch.id)).toHaveLength(1);
  });

  it('an edit keeps the triggers it does not change: a pause, a resume or a rename fires nothing again', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const late = await task(ana, 'Steady late', { dueOn: yesterday });
    // Keys in another order than the schema's, as jsonb gives them back too.
    const triggers = [
      {
        where: { title: { contains: 'Steady' }, done: false, dueOn: { lt: '$today' } },
        everyMinutes: 5,
        entity: 'task',
        kind: 'condition',
      },
      { cron: '0 9 * * 1', kind: 'recurring' },
      { at: new Date(Date.now() + 3_600_000).toISOString(), kind: 'once' },
      { where: { title: 'Steady', done: false }, on: ['visit.created'], kind: 'event' },
    ];
    const steady = await agent(ana, {
      name: 'Steady',
      instructions: 'Report what started this run.',
      scope: { tools: ['list-tasks'] },
      triggers,
    });
    const rowsOf = async () =>
      (
        await pool.query(
          'select id, next_at from app.agent_triggers where agent_id = $1 order by position',
          [steady.id],
        )
      ).rows as { id: string; next_at: Date | null }[];
    const before = await rowsOf();
    expect(before).toHaveLength(4);
    await svc().tick(new Date(Date.now() + 1000));
    const run = await eventually(
      async () => (await runsOf(steady.id)).find((r) => r.status === 'done'),
      20_000,
    );
    const hitsOf = async () =>
      (
        await pool.query('select record_id from app.agent_condition_hits where trigger_id = $1', [
          before[0].id,
        ])
      ).rows.map((r) => r.record_id);
    expect(await hitsOf()).toEqual([late.id]);
    const ticked = await rowsOf();

    // A pause and a resume (status only), then a rename with the whole definition again, as the
    // editor saves it.
    for (const status of ['paused', 'active'])
      expect((await ana.call('PATCH', `/api/agents/${steady.id}`, { status }, inA())).status).toBe(
        200,
      );
    const renamed = await ana.call(
      'PATCH',
      `/api/agents/${steady.id}`,
      { name: 'Steady still', triggers, scope: { tools: ['list-tasks'] } },
      inA(),
    );
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(await rowsOf()).toEqual(ticked);
    expect(await hitsOf()).toEqual([late.id]);
    const { rows } = await pool.query('select trigger_id from app.agent_runs where id = $1', [
      run.id,
    ]);
    expect(rows).toEqual([{ trigger_id: before[0].id }]);

    // Due again: the record it already saw starts nothing.
    await pool.query('update app.agent_triggers set next_at = now() where id = $1', [before[0].id]);
    await svc().tick(new Date(Date.now() + 1000));
    await new Promise((r) => setTimeout(r, 1000));
    expect(await runsOf(steady.id)).toHaveLength(1);

    // A trigger that does change starts again, under a new row.
    const moved = await ana.call(
      'PATCH',
      `/api/agents/${steady.id}`,
      { triggers: [triggers[0], { cron: '0 10 * * 1', kind: 'recurring' }] },
      inA(),
    );
    expect(moved.status).toBe(200);
    const now = await rowsOf();
    expect(now.map((r) => r.id)).toEqual([before[0].id, expect.any(String)]);
    expect(now[1].id).not.toBe(before[1].id);
    await ana.call('PATCH', `/api/agents/${steady.id}`, { status: 'paused' }, inA());
  });

  it('a time that fired does not stop an edit: a rename, a new order, a removal fire nothing again', async () => {
    // Inside the minute a new time may be late by; past it by the time of the edits.
    const at = new Date(Date.now() - 57_000).toISOString();
    const once = { kind: 'once', at };
    const schedule = { kind: 'recurring', cron: '0 9 * * 1' };
    const scope = { tools: ['list-tasks'] };
    const fired = await agent(ana, {
      name: 'Fired once',
      instructions: 'Count my open tasks.',
      scope,
      triggers: [schedule, once],
    });
    const rowsOf = async () =>
      (
        await pool.query(
          'select id, position, next_at from app.agent_triggers where agent_id = $1 order by position',
          [fired.id],
        )
      ).rows as { id: string; position: number; next_at: Date | null }[];
    await svc().tick(new Date());
    await eventually(async () => (await runsOf(fired.id)).find((r) => r.status === 'done'), 20_000);
    const ticked = await rowsOf();
    expect(ticked).toHaveLength(2);
    expect(ticked[1].next_at).toBeNull();
    const wait = new Date(at).getTime() + 61_000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    // A rename alone, and the whole definition again as the editor saves it.
    for (const body of [
      { name: 'Fired, renamed' },
      { name: 'Fired', instructions: 'Count my open tasks.', scope, triggers: [schedule, once] },
    ]) {
      const res = await ana.call('PATCH', `/api/agents/${fired.id}`, body, inA());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(await rowsOf()).toEqual(ticked);
    // A new order keeps both rows; removing the schedule moves the time up, still its row.
    const swapped = await ana.call(
      'PATCH',
      `/api/agents/${fired.id}`,
      { triggers: [once, schedule] },
      inA(),
    );
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    expect(await rowsOf()).toEqual([
      { ...ticked[1], position: 0 },
      { ...ticked[0], position: 1 },
    ]);
    const removed = await ana.call('PATCH', `/api/agents/${fired.id}`, { triggers: [once] }, inA());
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await rowsOf()).toEqual([{ ...ticked[1], position: 0 }]);
    await svc().tick(new Date(Date.now() + 1000));
    await new Promise((r) => setTimeout(r, 1000));
    expect(await runsOf(fired.id)).toHaveLength(1);

    // A time that is new and past is still refused; the kept one is not.
    const late = await ana.call(
      'PATCH',
      `/api/agents/${fired.id}`,
      { triggers: [once, { kind: 'once', at: '2001-01-01T00:00:00Z' }] },
      inA(),
    );
    expect(late.status).toBe(400);
    expect(late.body.problems).toEqual(['triggers.1 (once): 2001-01-01T00:00:00Z is in the past']);
    await ana.call('PATCH', `/api/agents/${fired.id}`, { status: 'paused' }, inA());
  });

  it('an @-mention: the agent runs with the comment; one whose owner cannot read the record cannot be named', async () => {
    const helper = await agent(ana, {
      name: 'Helper',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'mention' }],
    });
    const rexs = await agent(rex, {
      name: 'Rex helper',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'mention' }],
    });
    const t = await task(ana, 'Discuss me');
    const offered = await ana.call(
      'GET',
      `/api/comments/mentionable?entity=task&id=${t.id}&q=Help`,
      undefined,
      inA(),
    );
    expect(offered.body.items).toEqual(
      expect.arrayContaining([{ kind: 'agent', id: helper.id, label: 'Helper' }]),
    );
    expect(JSON.stringify(offered.body.items)).not.toContain(rexs.id);
    const refused = await ana.call(
      'POST',
      '/api/comments',
      { entity: 'task', recordId: t.id, body: `@[Rex helper](agent:${rexs.id}) look` },
      inA(),
    );
    expect(refused.status).toBe(403);
    const said = await ana.call(
      'POST',
      '/api/comments',
      { entity: 'task', recordId: t.id, body: `@[Helper](agent:${helper.id}) have a look` },
      inA(),
    );
    expect(said.status).toBe(200);
    const run = await eventually(
      async () => (await runsOf(helper.id)).find((r) => r.status === 'done'),
      20_000,
    );
    const detail = await settled(ana, run.id);
    expect(detail.trigger.kind).toBe('mention');
    expect(detail.reply).toContain('have a look');
    expect(detail.reply).toContain(t.id);
  });

  it('an @-mention of an agent with no saved mention trigger starts no run', async () => {
    const unsaved = await agent(ana, {
      name: 'Unsaved helper',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'mention' }],
    });
    // Its trigger row is gone (out of step with its definition): no time to compare events with.
    await pool.query('delete from app.agent_triggers where agent_id = $1', [unsaved.id]);
    const t = await task(ana, 'Mention without a trigger');
    const said = await ana.call(
      'POST',
      '/api/comments',
      { entity: 'task', recordId: t.id, body: `@[Unsaved helper](agent:${unsaved.id}) look` },
      inA(),
    );
    expect(said.status).toBe(200);
    await eventually(
      async () =>
        (
          await pool.query(
            `select relayed_at from app.domain_events
              where name = 'comment.mentioned' and row->'target'->>'id' = $1`,
            [unsaved.id],
          )
        ).rows[0]?.relayed_at ?? undefined,
      20_000,
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(await runsOf(unsaved.id)).toHaveLength(0);
  });

  it('a WhatsApp message: the inbound hook starts the agent, and leaves the message to the assistant', async () => {
    expect(inboundHooks.has('agents')).toBe(true);
    const listener = await agent(ana, {
      name: 'Listener',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'message', contains: ['price'] }],
    });
    const msg = (text: string, id: string) => ({
      tenantId,
      contactId: randomUUID(),
      message: {
        providerMessageId: id,
        to: '1',
        from: '919800000000',
        profileName: 'Priya',
        at: new Date(),
        body: { kind: 'text' as const, text },
      },
    });
    expect(await svc().onInbound(msg('hello there', `wamid.${randomUUID()}`))).toBe(0);
    const id = `wamid.${randomUUID()}`;
    expect(await svc().onInbound(msg('What is the PRICE of it?', id))).toBe(1);
    // The same message again (a retry) starts nothing more.
    expect(await svc().onInbound(msg('What is the PRICE of it?', id))).toBe(0);
    const run = await eventually(
      async () => (await runsOf(listener.id)).find((r) => r.status === 'done'),
      20_000,
    );
    const reply = (await settled(ana, run.id)).reply ?? '';
    expect(reply).toContain('What is the PRICE of it?');
    expect(reply).toContain('Priya');
  });

  it('a signed webhook to an agents connection starts the agents that take its type', async () => {
    const conn = await ana.call(
      'POST',
      '/api/integrations/connections',
      { connector: 'agent-webhooks', label: 'Their system' },
      inA(),
    );
    expect(conn.status).toBe(201);
    const { id, inboundPath } = conn.body.value;
    const secret = conn.body.credentials.secret as string;
    const hooked = await agent(ana, {
      name: 'Hooked',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'webhook', connectionId: id, on: ['parcel.*'] }],
    });
    const post = async (type: string) => {
      const raw = JSON.stringify({ type, data: { ref: `R-${type}` } });
      const headers = signWebhook({ secrets: [secret], id: `msg_${randomUUID()}`, body: raw });
      const res = await fetch(`${server.base}${inboundPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: raw,
      });
      expect(res.status).toBeLessThan(300);
    };
    await post('invoice.paid');
    await post('parcel.arrived');
    const run = await eventually(
      async () => (await runsOf(hooked.id)).find((r) => r.status === 'done'),
      20_000,
    );
    const reply = (await settled(ana, run.id)).reply ?? '';
    expect(reply).toContain('R-parcel.arrived');
    await new Promise((r) => setTimeout(r, 1000));
    expect(await runsOf(hooked.id)).toHaveLength(1);
  });
});

describe('the run log', () => {
  it('is its owner’s and the managers’: another person or business gets 404; live updates follow', async () => {
    const counter = await agent(rex, {
      name: 'Logged',
      instructions: 'Count my open tasks.',
      scope: { tools: ['list-tasks'] },
    });
    const [rexLive, samLive] = [await live(rex), await live(sam)];
    try {
      const id = await runNow(rex, counter.id);
      await settled(rex, id);
      await eventually(() => rexLive.events().find((e) => e.type === 'agent_run' && e.id === id));
      // A manager sees how it went, not what it said: that is the records as Rex reads them.
      expect(await settled(ana, id)).toMatchObject({
        id,
        status: 'done',
        reply: null,
        messages: [],
      });
      expect((await settled(rex, id)).reply).toMatch(/open task/);
      expect((await sam.call('GET', `/api/agent-runs/${id}`, undefined, inA())).status).toBe(404);
      expect((await bob.call('GET', `/api/agent-runs/${id}`)).status).toBe(404);
      expect((await bob.call('GET', `/api/agent-runs?agentId=${counter.id}`)).status).toBe(404);
      const page = (
        await rex.call('GET', `/api/agent-runs?agentId=${counter.id}`, undefined, inA())
      ).body;
      expect(page.items.map((r: { id: string }) => r.id)).toEqual([id]);
      expect(samLive.events().filter((e) => e.type === 'agent_run')).toEqual([]);
    } finally {
      rexLive.close();
      samLive.close();
    }
  });

  it('erasing a person deletes the agents they own; their export lists them', async () => {
    const gone = new Person('Gone Agents');
    await gone.signUp();
    await addMember(gone, tenantId, ['fixture_runner']);
    const theirs = await agent(gone, { name: 'To erase', instructions: 'Count my open tasks.' });
    const { DB } = await import('../../dist/testing-internals.js');
    const db = server.app?.get(DB, { strict: false }) as Parameters<
      typeof exportPersonalData
    >[0]['db'] & { transaction: <T>(f: (tx: never) => Promise<T>) => Promise<T> };
    const subject = { kind: 'user' as const, userId: gone.id };
    const exported = await exportPersonalData({ subject, tenantId, db });
    expect(exported.agents).toEqual([expect.objectContaining({ id: theirs.id, name: 'To erase' })]);
    const { counts } = await db.transaction((tx) =>
      eraseWithContributors({ tx, subject, tenantId }),
    );
    expect(counts.agents).toBe(1);
    expect((await pool.query('select 1 from app.agents where id = $1', [theirs.id])).rows).toEqual(
      [],
    );
  });
});
