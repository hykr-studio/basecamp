// The application's languages in the assistant: the instruction that pins one, the scripted
// model reading it back, the agent's version, and the eval scorer's language of an answer.
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { defineLanguages, resetLanguages, setLanguages } from '@hykr/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { defineScript, fakeModel, say } from './fake/engine.js';
import { replyLanguage } from './scorers.js';
import { agentVersion } from './version.js';

afterEach(resetLanguages);

// A language unlike English in script and one in English's: neither is the framework's.
const set = defineLanguages({
  el: { name: 'Ελληνικά', english: 'Greek', letters: /[Ͱ-Ͽ]/ },
  de: { name: 'Deutsch', english: 'German' },
});

const options = (system: string, text: string) =>
  ({
    prompt: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text }] },
    ],
  }) as unknown as LanguageModelV2CallOptions;

// The scripted model's answer is the language it took the turn to be in.
const model = fakeModel(
  [defineScript({ name: 'lang', match: () => true, step: (_, turn) => [say(turn.lang)] })],
  'help',
);
const langOfTurn = async (system: string, text: string) => {
  const { content } = await model.doGenerate(options(system, text));
  return content.find((p) => p.type === 'text')?.text;
};

describe('a turn’s language in the scripted model', () => {
  it('is the pinned language, by its English name, when the application declares it', async () => {
    setLanguages(set);
    expect(await langOfTurn('You help.\nReply in German.', 'hello')).toBe('de');
    expect(await langOfTurn('You help.', 'γεια σου')).toBe('el');
    expect(await langOfTurn('You help.', 'hello')).toBe('en');
  });

  it('knows only the declared languages', async () => {
    expect(await langOfTurn('You help.\nReply in German.', 'γεια σου')).toBe('en');
  });
});

describe('the agent version', () => {
  it('changes with the languages its instructions can name', () => {
    const english = agentVersion('Be brief.', 'fake/scripted');
    setLanguages(set);
    expect(agentVersion('Be brief.', 'fake/scripted')).not.toBe(english);
  });
});

describe('replyLanguage', () => {
  it('decides among the declared languages, by their letters', () => {
    expect(replyLanguage('Καλημέρα, "Call the plumber" is done', set)).toBe('el');
    expect(replyLanguage('All done.', set)).toBe('en');
    // A stray letter is not a word; two scripts are mixed.
    expect(replyLanguage('Done α', set)).toBe('mixed');
    const two = defineLanguages({
      el: { name: 'Ελληνικά', english: 'Greek', letters: /[Ͱ-Ͽ]/ },
      ru: { name: 'Русский', english: 'Russian', letters: /[Ѐ-ӿ]/ },
    });
    expect(replyLanguage('Καλημέρα Привет', two)).toBe('mixed');
  });
});
