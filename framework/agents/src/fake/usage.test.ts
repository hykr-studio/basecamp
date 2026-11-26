import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { fakeModel, say } from './engine.js';

const options = (text: string) =>
  ({
    prompt: [
      { role: 'system', content: 'You help.' },
      { role: 'user', content: [{ type: 'text', text }] },
    ],
  }) as unknown as LanguageModelV2CallOptions;

const model = fakeModel([], 'I can help with that.');

describe('the scripted model reports usage', () => {
  it('counts the prompt and the reply, a token per four characters', async () => {
    const short = await model.doGenerate(options('hi'));
    expect(short.usage.inputTokens).toBeGreaterThan(0);
    expect(short.usage.outputTokens).toBe(Math.ceil('I can help with that.'.length / 4));
    expect(short.usage.totalTokens).toBe(
      (short.usage.inputTokens ?? 0) + (short.usage.outputTokens ?? 0),
    );
    // A longer prompt costs more; the same prompt costs the same.
    const long = await model.doGenerate(options('hi '.repeat(100)));
    expect(long.usage.inputTokens).toBeGreaterThan(short.usage.inputTokens ?? 0);
    expect((await model.doGenerate(options('hi'))).usage).toEqual(short.usage);
  });

  it('reports the same usage when it streams', async () => {
    const whole = await model.doGenerate(options('hello'));
    const { stream } = await model.doStream(options('hello'));
    const parts: LanguageModelV2StreamPart[] = [];
    for await (const part of stream as unknown as AsyncIterable<LanguageModelV2StreamPart>)
      parts.push(part);
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish && 'usage' in finish ? finish.usage : undefined).toEqual(whole.usage);
  });

  it('counts at least one token out', async () => {
    const quiet = fakeModel(
      [{ name: 'quiet', match: () => true, step: () => [say('')] }],
      'unused',
    );
    expect((await quiet.doGenerate(options('x'))).usage.outputTokens).toBe(1);
  });
});
