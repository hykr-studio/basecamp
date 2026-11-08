// A run that reaches the business's cap in the middle (H3): once a tool comes back 402
// `credits_paused`, the run ends with the paused sentence, calls nothing more and spends nothing.
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { call, defineScript, fakeModel, say } from './fake/engine.js';
import { EndWhenPaused, isPausedRefusal, pausedText } from './paused.js';

let calls: string[] = [];
const paused = {
  ok: false,
  status: 402,
  error: { error: 'credits_paused', rule: 'x', reason: 'y' },
};
const forbidden = { ok: false, status: 403, error: { error: 'forbidden', reason: 'Not yours' } };

const tool = (id: string, answer: () => unknown) =>
  createTool({
    id,
    description: id,
    inputSchema: z.object({}),
    execute: async () => {
      calls.push(id);
      return answer();
    },
  });

const scripts = [
  defineScript({
    name: 'two-steps',
    match: (text) => (text === 'first then second' ? true : undefined),
    step: (_, turn) => {
      if (!turn.result('first')) return [call('first', {})];
      if (!turn.result('second')) return [call('second', {})];
      return [say('Both done.')];
    },
  }),
];

function agent(second: () => unknown) {
  return new Agent({
    id: 'paused-tester',
    name: 'Paused tester',
    instructions: 'Help.',
    model: fakeModel(scripts, 'I help.'),
    tools: {
      first: tool('first', () => ({ ok: true, result: {} })),
      second: tool('second', second),
    },
    inputProcessors: [new EndWhenPaused()],
  });
}

const context = (lang?: string) => {
  const rc = new RequestContext();
  rc.set('tenantId', 't1');
  if (lang) rc.set('lang', lang);
  return rc;
};

beforeEach(() => {
  calls = [];
});

describe('a run that reaches the cap in the middle', () => {
  it('ends with the paused sentence once a tool is refused for credits', async () => {
    let n = 0;
    const out = await agent(() => (++n === 1 ? paused : { ok: true })).generate(
      'first then second',
      { requestContext: context(), maxSteps: 8 },
    );
    expect(out.text).toBe(pausedText('en'));
    expect(calls).toEqual(['first', 'second']);
  });

  it('says it in the turn’s language, streamed too', async () => {
    const out = await agent(() => paused).stream('first then second', {
      requestContext: context('hi'),
      maxSteps: 8,
    });
    expect(await out.text).toBe(pausedText('hi'));
    expect(calls).toEqual(['first', 'second']);
  });

  it('leaves any other refusal to the model', async () => {
    const out = await agent(() => forbidden).generate('first then second', {
      requestContext: context(),
      maxSteps: 8,
    });
    expect(out.text).not.toBe(pausedText('en'));
    expect(out.text).toContain('Not yours');
  });

  it('knows the refusal by its status and error', () => {
    expect(isPausedRefusal(paused)).toBe(true);
    expect(isPausedRefusal(forbidden)).toBe(false);
    expect(isPausedRefusal({ ok: false, status: 402, error: { error: 'other' } })).toBe(false);
    expect(isPausedRefusal(null)).toBe(false);
  });
});
