import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { defineLanguages, resetLanguages, setLanguages } from '@hykr/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, defineScript, runScripts, say, written } from './engine.js';

// Hindi and Telugu, as an application declares them: the framework speaks only what it is given.
const languages = defineLanguages({
  hi: { name: 'हिंदी', english: 'Hindi', locale: 'hi-IN', letters: /[ऀ-ॣ०-९ॱ-ॿ]/ },
  te: { name: 'తెలుగు', english: 'Telugu', locale: 'te-IN', letters: /[ఀ-౿]/ },
});
beforeAll(() => setLanguages(languages));
afterAll(resetLanguages);

/** A turn: the person's words, then each tool call's output as the model sees it. */
const prompt = (text: string, outputs: { tool: string; output: unknown }[] = []) =>
  [
    { role: 'system', content: 'You help.' },
    { role: 'user', content: [{ type: 'text', text }] },
    ...outputs.map(({ tool, output }, i) => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: tool, output }],
    })),
  ] as unknown as LanguageModelV2Prompt;

const clear = defineScript({
  name: 'clear',
  match: (text) => (/^(clear done|साफ़ करो)$/u.test(text) ? true : undefined),
  step: (_, turn) => {
    const r = turn.result('clear-done');
    if (!r) return [call('clear-done', {})];
    return [say(written(r, () => 'Cleared.', turn))];
  },
});
const textOf = (content: ReturnType<typeof runScripts>) =>
  content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('');

describe('the scripted model and the tools a turn offers (V7)', () => {
  it('calls a tool the turn offers, and says it cannot when the turn does not', () => {
    const calls = [{ type: 'tool-call', toolName: 'clear-done' }];
    expect(
      runScripts(prompt('clear done'), [clear], 'help', new Set(['clear-done'])),
    ).toMatchObject(calls);
    expect(textOf(runScripts(prompt('clear done'), [clear], 'help', new Set(['other'])))).toBe(
      "I can't do that here.",
    );
    expect(textOf(runScripts(prompt('साफ़ करो'), [clear], 'help', new Set()))).toBe(
      'मैं यह यहाँ नहीं कर सकता।',
    );
    // No tool list in the call: unknown, so nothing is filtered.
    expect(runScripts(prompt('clear done'), [clear], 'help')).toMatchObject(calls);
  });

  it('a tool error that is not an API answer never reads "undefined"', () => {
    for (const output of [
      { type: 'error-text', value: 'Tool "clear-done" not found. Available tools: x' },
      { type: 'error-json', value: { name: 'ToolNotFoundError', message: 'not found' } },
    ]) {
      const reply = textOf(
        runScripts(prompt('clear done', [{ tool: 'clear-done', output }]), [clear], 'help'),
      );
      expect(reply).toBe("I couldn't do that: something went wrong.");
    }
  });

  it("an API refusal says its reason, else its status, in the turn's language", () => {
    const refused = (error: unknown, text = 'clear done') =>
      textOf(
        runScripts(
          prompt(text, [
            {
              tool: 'clear-done',
              output: { type: 'json', value: { ok: false, status: 404, error } },
            },
          ]),
          [clear],
          'help',
        ),
      );
    expect(refused({ reason: 'No such list' })).toBe("I couldn't do that: No such list.");
    expect(refused(null)).toBe("I couldn't do that: the API answered 404.");
    expect(refused(null, 'साफ़ करो')).toBe('मैं यह नहीं कर सका: API ने 404 लौटाया।');
  });

  it('a parked write says who decides it', () => {
    const parked = (approval: Record<string, unknown>) =>
      written({ ok: true, result: { status: 'needs_approval', approval } }, () => 'Cleared.', {
        lang: 'en',
        spoken: false,
        surfaces: ['inline'],
      });
    expect(parked({ summary: 'Clear 2', canDecide: true })).toBe(
      "I've asked for your approval: Clear 2. Nothing changes until you approve it.",
    );
    expect(parked({ summary: 'Clear 2', canDecide: false })).toBe(
      "I've asked the team for approval: Clear 2. Nothing changes until they decide.",
    );
    // A result without the fact (older runs) reads as the person's own.
    expect(parked({ summary: 'Clear 2' })).toContain('your approval');
  });
});
