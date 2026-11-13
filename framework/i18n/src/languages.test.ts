// The application's languages: declared once, English always first, everything else optional.
import { afterEach, describe, expect, it } from 'vitest';
import {
  count,
  dayText,
  defineLanguages,
  englishName,
  isLang,
  languageName,
  languages,
  languagesFromWire,
  localeOf,
  pick,
  resetLanguages,
  scriptCounts,
  scriptOf,
  setLanguages,
  speechTagOf,
} from './index.js';

afterEach(resetLanguages);

// Greek and German: a script the framework has never seen, and one it shares with English.
const set = defineLanguages({
  el: { name: 'Ελληνικά', english: 'Greek', locale: 'el-GR', letters: /[Ͱ-Ͽ]/ },
  de: { name: 'Deutsch', english: 'German', locale: 'de-DE', speech: 'de-AT' },
});

describe('defineLanguages', () => {
  it('puts English first, with its defaults, and keeps the declared order', () => {
    expect(set.codes).toEqual(['en', 'el', 'de']);
    expect(set.get('en')).toMatchObject({ name: 'English', locale: 'en-GB', speech: 'en-GB' });
    expect(set.get('de')).toMatchObject({ locale: 'de-DE', speech: 'de-AT' });
    expect(set.get('el')?.speech).toBe('el-GR');
    expect(defineLanguages({}).codes).toEqual(['en']);
  });

  it('lets the application change English', () => {
    const own = defineLanguages({ en: { locale: 'en-US', speech: 'en-IN' } });
    expect(own.get('en')).toMatchObject({ name: 'English', locale: 'en-US', speech: 'en-IN' });
  });

  it('refuses a bad code, a missing name, an unknown field and a locale Intl cannot read', () => {
    expect(() => defineLanguages({ German: { name: 'Deutsch', english: 'German' } })).toThrow(
      /not a language code/,
    );
    expect(() => defineLanguages({ de: { name: '', english: 'German' } })).toThrow(/its name/);
    expect(() =>
      defineLanguages({ de: { name: 'Deutsch', english: 'German', lettrs: /x/ } as never }),
    ).toThrow(/"lettrs" is not part of a language/);
    expect(() =>
      defineLanguages({ de: { name: 'Deutsch', english: 'German', locale: 'not a locale!' } }),
    ).toThrow(/not a locale/);
  });

  it('a global pattern is used one character at a time without remembering its place', () => {
    const g = defineLanguages({ el: { name: 'Ελληνικά', english: 'Greek', letters: /[α-ω]/g } });
    expect([g.scriptOf('αβ'), g.scriptOf('αβ'), g.scriptOf('αβ')]).toEqual(['el', 'el', 'el']);
  });
});

describe('the process’s languages', () => {
  it('are English alone until the application says, then its own', () => {
    expect(languages().codes).toEqual(['en']);
    expect(isLang('el')).toBe(false);
    setLanguages(set);
    expect(isLang('el')).toBe(true);
    expect(isLang('hi')).toBe(false);
    expect(languageName('el')).toBe('Ελληνικά');
    expect(englishName('de')).toBe('German');
    expect(localeOf('el')).toBe('el-GR');
    expect(speechTagOf('de')).toBe('de-AT');
    // A language not declared reads as English.
    expect(localeOf('hi')).toBe('en-GB');
    expect(speechTagOf('hi')).toBe('en-GB');
  });

  it('write dates and counts in the declared locale', () => {
    setLanguages(set);
    expect(dayText('2026-10-05', 'de')).toMatch(/Mo/);
    expect(dayText('2026-10-05', 'el')).toMatch(/Δευ/);
    expect(count(2, { en: ['task', 'tasks'], de: ['Aufgabe', 'Aufgaben'] }, 'de')).toBe(
      '2 Aufgaben',
    );
  });

  it('tell a text’s language by the declared letters, the other languages before English', () => {
    setLanguages(set);
    expect(scriptOf('γεια σου friend')).toBe('el');
    expect(scriptOf('hallo')).toBe('en');
    expect(scriptOf('42 !')).toBeUndefined();
    expect(scriptCounts('γεια hi')).toEqual({ el: 4, en: 2 });
  });
});

describe('pick', () => {
  it('gives the language’s entry, else English’s, an empty one included', () => {
    expect(pick({ en: 'Hello', de: 'Hallo' }, 'de')).toBe('Hallo');
    expect(pick({ en: 'Hello', de: '' }, 'de')).toBe('Hello');
    expect(pick({ en: 'Hello' }, 'el')).toBe('Hello');
    expect(pick({ en: ['a', 'b'] as const, el: ['α', 'β'] as const }, 'el')).toEqual(['α', 'β']);
  });
});

describe('the wire', () => {
  it('carries a set to a process that does not load the application', () => {
    const back = languagesFromWire(JSON.parse(JSON.stringify(set.toWire())));
    expect(back.codes).toEqual(set.codes);
    expect(back.get('de')).toMatchObject({ english: 'German', speech: 'de-AT' });
    expect(back.scriptOf('γεια')).toBe('el');
    expect(back.get('de')?.letters).toBeUndefined();
  });
});
