import { safely, type ToolKit } from '@hykr/core/tools';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { extractAgentResponseMessages } from '@mastra/evals/scorers/utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { durableAgent, findSuspension, resumeSuspension } from './durable.js';
import { call, decided, defineScript, fakeModel, items, say, written } from './fake/engine.js';

/** What the API was asked: a parked write must reach it once, never again on resume. */
let asked: string[] = [];
const kit = {
  clientFor: () => {
    throw new Error('not used');
  },
  registry: {},
} as unknown as ToolKit;

const parkIt = createTool({
  id: 'park-it',
  description: 'A write that waits for approval.',
  inputSchema: z.object({ n: z.number() }),
  execute: async ({ n }, ctx) =>
    safely('park-it', ctx, kit, async () => {
      asked.push(`park-${n}`);
      return {
        status: 'needs_approval' as const,
        approval: { id: `ap-${n}`, summary: `Tidy ${n}` },
      };
    }),
});
const look = createTool({
  id: 'look',
  description: 'A read.',
  inputSchema: z.object({}),
  execute: async (_input, ctx) =>
    safely('look', ctx, kit, async () => {
      asked.push('look');
      return { items: [{ id: '1', title: 'One' }] };
    }),
});

const scripts = [
  defineScript({
    name: 'tidy',
    match: (text) => /^tidy (\d+)$/.exec(text)?.[1],
    step: (n, turn) => {
      const r = turn.result('park-it');
      if (!r) return [call('park-it', { n: Number(n) })];
      if (decided(r) !== 'approved') return [say(written(r, () => 'Tidied.', turn))];
      const seen = turn.result('look');
      if (!seen) return [call('look', {})];
      return [say(`Tidied ${n}; ${items(seen).length} left.`)];
    },
  }),
  defineScript({
    name: 'look-then',
    match: (text) => (text === 'look then tidy' ? true : undefined),
    step: (_, turn) => {
      if (!turn.result('look')) return [say('Looking first.'), call('look', {})];
      const r = turn.result('park-it');
      if (!r) return [call('park-it', { n: 3 })];
      return [say(`after ${decided(r)}`)];
    },
  }),
  defineScript({
    name: 'both',
    match: (text) => (text === 'tidy both' ? true : undefined),
    step: (_, turn) => {
      const done = turn.steps.filter((s) => s.toolName === 'park-it');
      if (!done.length) return [call('park-it', { n: 1 }), call('park-it', { n: 2 })];
      return [say(done.map((s) => decided(s.outcome)).join(' and '))];
    },
  }),
];

function setup() {
  const agent = new Agent({
    id: 'tester',
    name: 'Tester',
    instructions: 'Help.',
    model: fakeModel(scripts, 'I tidy.'),
    tools: { 'park-it': parkIt, look },
  });
  const mastra = new Mastra({ agents: { tester: agent }, storage: new InMemoryStore() });
  return { mastra, agents: { tester: mastra.getAgent('tester') } };
}

const contextFor = (runId: string) => {
  const rc = new RequestContext();
  rc.set('actingFor', 'user:u1');
  rc.set('tenantId', 't1');
  rc.set('runId', runId);
  rc.set('channel', 'app');
  rc.set('surfaces', ['text']);
  rc.set('timeZone', 'Asia/Kolkata');
  return rc;
};

const decision = (approvalId: string, status: string) => ({
  approvalId,
  status,
  summary: `Tidy ${approvalId.slice(3)}`,
});

beforeEach(() => {
  asked = [];
});

describe('a durable run', () => {
  it('suspends on a parked write, and the turn still reads as a parked one', async () => {
    const { agents, mastra } = setup();
    const agent = durableAgent(agents.tester);
    const runId = `run${Date.now()}a`;
    const output = await agent.stream('tidy 1', { requestContext: contextFor(runId) });
    // The stream (what the app renders) and the saved reply, read together.
    const types: string[] = [];
    const reading = (async () => {
      for await (const chunk of output.fullStream as AsyncIterable<{ type: string }>)
        types.push(chunk.type);
    })();
    const [text, results] = await Promise.all([output.text, output.toolResults, reading]);
    expect(await output.finishReason).toBe('suspended');
    expect(types).toContain('tool-result');
    expect(types).not.toContain('tool-call-suspended');
    // The waiting line, then the end of the turn (a suspended stream has none of its own).
    expect(types.slice(-4)).toEqual(['text-start', 'text-delta', 'text-end', 'finish']);
    expect(text).toBe(
      "I've asked for your approval: Tidy 1. Nothing changes until you approve it.",
    );
    const parked = (results as { payload: { toolName: string; result: { result: unknown } } }[])[0]
      .payload;
    expect(parked.toolName).toBe('park-it');
    expect(parked.result.result).toMatchObject({
      status: 'needs_approval',
      approval: { id: 'ap-1' },
    });

    // Stored by Mastra under the turn's run id, with what a resume needs.
    const s = await findSuspension(mastra, agents, { runId, approvalId: 'ap-1' });
    expect(s).toMatchObject({ agent: 'tester', runId, toolName: 'park-it' });
    expect(s?.parked.context).toMatchObject({
      actingFor: 'user:u1',
      tenantId: 't1',
      channel: 'app',
      timeZone: 'Asia/Kolkata',
      surfaces: ['text'],
    });
    expect(await findSuspension(mastra, agents, { runId, approvalId: 'ap-9' })).toBeUndefined();
  });

  it('scorers (the evals) read the waiting line as the reply', async () => {
    const { agents } = setup();
    const out = await durableAgent(agents.tester).generate('tidy 1', {
      requestContext: contextFor(`run${Date.now()}s`),
      returnScorerData: true,
    });
    const reply = extractAgentResponseMessages(out.scoringData?.output ?? []).join('\n');
    expect(reply).toContain("I've asked for your approval: Tidy 1.");
  });

  it('resumes with the decision: the write is not asked again, the plan goes on', async () => {
    const { agents, mastra } = setup();
    const runId = `run${Date.now()}b`;
    await durableAgent(agents.tester).generate('tidy 1', { requestContext: contextFor(runId) });
    const s = await findSuspension(mastra, agents, { runId, approvalId: 'ap-1' });
    if (!s) throw new Error('not suspended');
    const out = await resumeSuspension(agents.tester, s, decision('ap-1', 'approved') as never, {
      requestContext: contextFor(runId),
    });
    expect(await out.text).toBe('Tidied 1; 1 left.');
    expect(await out.finishReason).toBe('stop');
    // Parked once; the follow-on read ran for real.
    expect(asked).toEqual(['park-1', 'look']);
    expect(await findSuspension(mastra, agents, { runId, approvalId: 'ap-1' })).toBeUndefined();
  });

  it('a rejection says nothing changed and stops', async () => {
    const { agents, mastra } = setup();
    const runId = `run${Date.now()}c`;
    const first = await durableAgent(agents.tester).generate('tidy 1', {
      requestContext: contextFor(runId),
    });
    expect(first.text).toContain('Tidy 1');
    expect(first.toolResults).toHaveLength(1);
    const s = await findSuspension(mastra, agents, { runId, approvalId: 'ap-1' });
    if (!s) throw new Error('not suspended');
    const out = await resumeSuspension(agents.tester, s, decision('ap-1', 'rejected') as never, {
      requestContext: contextFor(runId),
    });
    expect(await out.text).toBe('That was rejected, so nothing changed: Tidy 1.');
    expect(asked).toEqual(['park-1']);
  });

  it('a resume that names another approval is refused by the tool', async () => {
    const { agents, mastra } = setup();
    const runId = `run${Date.now()}d`;
    await durableAgent(agents.tester).generate('tidy 1', { requestContext: contextFor(runId) });
    const s = await findSuspension(mastra, agents, { runId, approvalId: 'ap-1' });
    if (!s) throw new Error('not suspended');
    const out = await resumeSuspension(agents.tester, s, decision('ap-7', 'approved') as never, {
      requestContext: contextFor(runId),
    });
    expect(await out.text).toContain('continues only once its approval is decided');
    expect(asked).toEqual(['park-1']);
  });

  it('two parked calls in one step: each decision resumes its own, the run goes on after both', async () => {
    const { agents, mastra } = setup();
    const runId = `run${Date.now()}e`;
    const first = await durableAgent(agents.tester).generate('tidy both', {
      requestContext: contextFor(runId),
    });
    expect(first.toolResults).toHaveLength(2);
    expect(first.text).toContain('Tidy 1');
    expect(first.text).toContain('Tidy 2');
    const two = await findSuspension(mastra, agents, { runId, approvalId: 'ap-2' });
    if (!two) throw new Error('not suspended');
    const partial = await resumeSuspension(
      agents.tester,
      two,
      decision('ap-2', 'rejected') as never,
      {
        requestContext: contextFor(runId),
      },
    );
    expect(await partial.finishReason).toBe('suspended');
    expect(await partial.text).toBe('');
    expect(await findSuspension(mastra, agents, { runId, approvalId: 'ap-2' })).toBeUndefined();
    const one = await findSuspension(mastra, agents, { runId, approvalId: 'ap-1' });
    if (!one) throw new Error('still suspended on the first');
    const last = await resumeSuspension(agents.tester, one, decision('ap-1', 'approved') as never, {
      requestContext: contextFor(runId),
    });
    expect(await last.text).toBe('approved and rejected');
    expect(asked).toEqual(['park-1', 'park-2']);
  });
});

describe('a resumed run reports only what it did after the decision', () => {
  it('leaves out the steps before the park', async () => {
    const { agents, mastra } = setup();
    const runId = `run${Date.now()}f`;
    const first = await durableAgent(agents.tester).generate('look then tidy', {
      requestContext: contextFor(runId),
    });
    expect(first.text).toBe(
      "Looking first.\n\nI've asked for your approval: Tidy 3. Nothing changes until you approve it.",
    );
    expect(
      first.toolResults.map((r: { payload: { toolName: string } }) => r.payload.toolName),
    ).toEqual(['look', 'park-it']);
    const s = await findSuspension(mastra, agents, { runId, approvalId: 'ap-3' });
    if (!s) throw new Error('not suspended');
    const out = await resumeSuspension(agents.tester, s, decision('ap-3', 'approved') as never, {
      requestContext: contextFor(runId),
    });
    // Not the words said before the park, nor its earlier tool results.
    expect(await out.text).toBe('after approved');
    const names = ((await out.toolResults) as { payload: { toolName: string } }[]).map(
      (r) => r.payload.toolName,
    );
    expect(names).toEqual(['park-it']);
    // Usage: the model calls since the park (the one that parked, and the one after), counted
    // once: the turn that parked counted only its first step.
    const used = await out.totalUsage;
    expect(used.outputTokens).toBeGreaterThan(0);
    expect(used.inputTokens).toBeGreaterThan(first.totalUsage.inputTokens ?? 0);
  });
});

describe('the scripted model on decided calls', () => {
  const outcome = (status: string, value?: object) => ({
    ok: true,
    result: { status, approval: { summary: 'Close it' }, ...(value ? { value } : {}) },
  });
  const done = () => 'Closed.';
  it('says how each was decided', () => {
    expect(written(outcome('approved'), done)).toBe('That was approved and is done: Close it.');
    expect(written(outcome('approved', { id: '1', title: 'x' }), done)).toBe('Closed.');
    expect(written(outcome('rejected'), done)).toBe(
      'That was rejected, so nothing changed: Close it.',
    );
    expect(written(outcome('expired'), done)).toBe(
      'Nobody decided it in time, so nothing changed: Close it.',
    );
    expect(written(outcome('needs_approval'), done)).toBe(
      "I've asked for your approval: Close it. Nothing changes until you approve it.",
    );
    expect(decided(outcome('expired'))).toBe('expired');
    expect(decided({ ok: true, result: { status: 'done' } })).toBeUndefined();
  });
});
