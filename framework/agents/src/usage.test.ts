// The guardrail's model calls are metered (H3): the wrapped model reports each generate's and
// each stream's tokens, with the turn's business, person, run and channel; without a business, or
// without a sink, nothing is reported.
import { RequestContext } from '@mastra/core/request-context';
import { generateText, streamText } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { defineScript, fakeModel, say } from './fake/engine.js';
import type { LanguageModel } from './models/registry.js';
import { type ModelUsage, meteredModel, setModelUsageSink } from './usage.js';

const model = fakeModel(
  [defineScript({ name: 'hi', match: () => true, step: () => [say('Safe.')] })],
  'help',
) as unknown as LanguageModel;

const turn = () => {
  const rc = new RequestContext();
  rc.set('tenantId', 't1');
  rc.set('actingFor', 'user:u1');
  rc.set('runId', 'run-1');
  rc.set('channel', 'app');
  return { requestContext: rc };
};

const seen: ModelUsage[] = [];
setModelUsageSink((u) => {
  seen.push(u);
});

afterEach(() => {
  seen.length = 0;
});

describe('a metered model', () => {
  it('reports a generate’s tokens for the turn’s business', async () => {
    const wrapped = meteredModel(model, { ref: 'fake/scripted', source: 'guardrail' }, turn());
    const out = await generateText({ model: wrapped, prompt: 'Is this safe?' });
    expect(out.text).toBe('Safe.');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantId: 't1',
      model: 'fake/scripted',
      source: 'guardrail',
      subject: 'user:u1',
      runId: 'run-1',
      channel: 'app',
    });
    expect(seen[0].inputTokens).toBeGreaterThan(0);
    expect(seen[0].outputTokens).toBeGreaterThan(0);
  });

  it('reports a stream’s tokens when it finishes', async () => {
    const wrapped = meteredModel(model, { ref: 'fake/scripted', source: 'guardrail' }, turn());
    const out = streamText({ model: wrapped, prompt: 'Is this safe?' });
    expect(await out.text).toBe('Safe.');
    expect(seen).toHaveLength(1);
    expect(seen[0].inputTokens).toBeGreaterThan(0);
  });

  it('reports nothing without a business', async () => {
    const wrapped = meteredModel(model, { ref: 'fake/scripted', source: 'guardrail' }, {});
    expect(wrapped).toBe(model);
    await generateText({ model: wrapped, prompt: 'Is this safe?' });
    expect(seen).toEqual([]);
  });

  it('reports nothing once the sink is removed, and never fails the call', async () => {
    setModelUsageSink(() => {
      throw new Error('down');
    });
    const wrapped = meteredModel(model, { ref: 'fake/scripted', source: 'guardrail' }, turn());
    expect((await generateText({ model: wrapped, prompt: 'x' })).text).toBe('Safe.');
    setModelUsageSink(undefined);
    await generateText({ model: wrapped, prompt: 'x' });
    expect(seen).toEqual([]);
    setModelUsageSink((u) => {
      seen.push(u);
    });
  });
});
