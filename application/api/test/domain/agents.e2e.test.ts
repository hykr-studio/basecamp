// The meetings module's ready-made agents (A6): a Monday summary of open to-dos, and a follow-up
// note when a meeting closes, made from the templates and run by the framework.

import { AgentsService } from '@hykr/api';
import { boot, eventually, Person, pool, server, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Compiled, like the app runs: Nest's DI needs the decorator metadata tsc emits.
import { server as application } from '../../dist/server.js';

const ana = new Person('Ana Agents');

type Template = {
  key: string;
  name: string;
  instructions: string;
  triggers: unknown[];
  scope: { tools: string[] };
  budget: Record<string, unknown>;
  available: boolean;
};

let templates: Template[] = [];

/** Ana's agent, made from one of the module's templates. */
async function fromTemplate(key: string) {
  const t = templates.find((x) => x.key === key);
  if (!t) throw new Error(`No template ${key}`);
  const res = await ana.call('POST', '/api/agents', {
    name: t.name,
    instructions: t.instructions,
    triggers: t.triggers,
    scope: t.scope,
    budget: t.budget,
    template: t.key,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.value as { id: string; template: string };
}

/** The agent's first finished run, as its log shows it. */
async function finishedRun(agentId: string) {
  const run = await eventually(async () => {
    const res = await ana.call('GET', `/api/agent-runs?agentId=${agentId}`);
    return (res.body.items as { id: string; status: string }[]).find((r) =>
      ['done', 'failed', 'refused'].includes(r.status),
    );
  }, 30_000);
  return (await ana.call('GET', `/api/agent-runs/${run.id}`)).body as {
    status: string;
    reply: string;
    runId: string;
    toolCalls: { tool: string; outcome: string }[];
  };
}

beforeAll(async () => {
  await boot(application);
  await ana.signUp();
  templates = (await ana.call('GET', '/api/agent-templates')).body.items;
}, 120_000);
afterAll(shutdown);

describe('the meetings module’s agents', () => {
  it('are offered as templates', () => {
    expect(templates.map((t) => [t.key, t.available])).toEqual(
      expect.arrayContaining([
        ['meetings.weekly-todos', true],
        ['meetings.follow-up', true],
      ]),
    );
  });

  it('Monday: the open to-dos, on the schedule', async () => {
    for (const title of ['Order tiles', 'Call the plumber'])
      expect((await ana.call('POST', '/api/todos', { title })).status).toBe(201);
    const weekly = await fromTemplate('meetings.weekly-todos');
    const { rows } = await pool.query(
      'select next_at from app.agent_triggers where agent_id = $1',
      [weekly.id],
    );
    const monday = new Date(rows[0].next_at);
    await server.app?.get(AgentsService, { strict: false }).tick(new Date(monday.getTime() + 1000));
    const run = await finishedRun(weekly.id);
    expect(run.status).toBe('done');
    expect(run.reply).toMatch(/^2 open to-dos:\n- (Order tiles|Call the plumber)/);
    expect(run.reply).toContain('Call the plumber');
  });

  it('meeting closed: a follow-up note on it, written by the agent for Ana', async () => {
    const follow = await fromTemplate('meetings.follow-up');
    const made = await ana.call('POST', '/api/meetings', {
      title: 'Kitchen walkthrough',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      attendees: ['Ravi'],
    });
    const meeting = made.body.value as { id: string };
    const closed = await ana.call('POST', `/api/meetings/${meeting.id}/close`, {
      summary: 'Walked the kitchen.',
      actionItems: [{ title: 'Send the cabinet sizes' }],
    });
    expect(closed.body.status).toBe('done');
    const run = await finishedRun(follow.id);
    expect(run.status).toBe('done');
    expect(run.reply).toBe('Drafted a follow-up for Kitchen walkthrough: 1 open to-do.');
    const notes = (await ana.call('GET', `/api/notes?meetingId=${meeting.id}`)).body.items as {
      title: string;
      body: string;
    }[];
    const note = notes.find((n) => n.title === 'Follow-up: Kitchen walkthrough');
    expect(note?.body).toContain('- Send the cabinet sizes');
    const { rows } = await pool.query(
      `select actor_kind, actor_id, acting_for, channel from audit.events
        where run_id = $1 and action = 'note.create'`,
      [run.runId],
    );
    expect(rows).toEqual([
      {
        actor_kind: 'agent',
        actor_id: `agent:${follow.id}`,
        acting_for: ana.id,
        channel: 'background',
      },
    ]);
  });
});
