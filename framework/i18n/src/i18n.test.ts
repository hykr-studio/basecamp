import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogs,
  count,
  dayText,
  defineLanguages,
  firstFew,
  langOf,
  type Noun,
  resetLanguages,
  scriptOf,
  setLanguages,
  t,
  whenText,
} from './index.js';

// The languages these tests speak: English, Hindi and Telugu, as an application declares them.
const languages = defineLanguages({
  hi: {
    name: 'हिंदी',
    english: 'Hindi',
    locale: 'hi-IN',
    letters: /[ऀ-ॣ०-९ॱ-ॿ]/,
  },
  te: { name: 'తెలుగు', english: 'Telugu', locale: 'te-IN', letters: /[ఀ-౿]/ },
});
beforeAll(() => setLanguages(languages));
afterAll(resetLanguages);

const todo: Noun = { en: ['to-do', 'to-dos'], hi: ['काम', 'काम'], te: ['పని', 'పనులు'] };

describe('catalogs', () => {
  it('every phrase the framework translates keeps its English placeholders', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, phrase] of Object.entries(catalogs.en)) {
      for (const lang of Object.keys(catalogs)) {
        const local = catalogs[lang]?.[key as keyof typeof catalogs.en];
        expect(local, `${lang}.${key}`).toBeTruthy();
        expect(vars(local as string), `${lang}.${key}`).toEqual(vars(phrase));
      }
    }
  });

  it('fills placeholders, and leaves an unknown one visible', () => {
    expect(t('en', 'said.waitingApproval', { summary: 'Delete "Tiles"' })).toBe(
      'Delete "Tiles" is waiting for your approval in the app.',
    );
    expect(t('te', 'said.andMore', { n: 2 })).toBe('మరో 2');
    expect(t('en', 'said.couldNot')).toBe("I couldn't do that: {reason}.");
  });

  it('a language the framework has no words for reads in English', () => {
    expect(t('de', 'said.andMore', { n: 2 })).toBe(t('en', 'said.andMore', { n: 2 }));
  });
});

describe('scriptOf', () => {
  it('reads the script, code-mixed included', () => {
    expect(scriptOf('జోడించు Call the plumber')).toBe('te');
    expect(scriptOf('Order tiles हटाओ')).toBe('hi');
    expect(scriptOf('add tiles')).toBe('en');
    expect(scriptOf('42')).toBeUndefined();
    // A danda is punctuation, not Hindi.
    expect(scriptOf('Done।')).toBe('en');
  });

  it('knows only the declared languages', () => {
    resetLanguages();
    expect(scriptOf('Order tiles हटाओ')).toBe('en');
    expect(scriptOf('हटाओ')).toBeUndefined();
    setLanguages(languages);
  });
});

describe('langOf', () => {
  it('reads locales and voice languages, and falls back to English', () => {
    expect(langOf('hi-IN')).toBe('hi');
    expect(langOf('te_IN')).toBe('te');
    expect(langOf('en-IN')).toBe('en');
    expect(langOf('auto')).toBe('en');
    expect(langOf('fr-FR')).toBe('en');
    expect(langOf(undefined)).toBe('en');
  });
});

describe('words for dates and counts', () => {
  it('days and times in each language', () => {
    expect(dayText('2026-10-05')).toBe('Mon 5 Oct');
    expect(dayText('2026-10-05', 'hi')).toMatch(/सोम/);
    expect(dayText('2026-10-05', 'te')).toMatch(/సోమ/);
    expect(whenText('2026-10-05T09:00:00Z', 'Asia/Kolkata')).toBe('Mon 5 Oct, 14:30');
    expect(whenText('2026-10-05T09:00:00Z', 'Asia/Kolkata', 'hi')).toMatch(/2:30|14:30/);
  });

  it('counts with the language’s plural, and in English for a language the noun lacks', () => {
    expect(count(1, todo)).toBe('1 to-do');
    expect(count(3, todo)).toBe('3 to-dos');
    expect(count(3, todo, 'te')).toBe('3 పనులు');
    expect(count(1, todo, 'hi')).toBe('1 काम');
    expect(count(3, { en: ['task', 'tasks'] }, 'te')).toBe('3 tasks');
  });

  it('names the first few, then how many more', () => {
    expect(firstFew(['a', 'b'])).toBe('a, b');
    expect(firstFew(['a', 'b', 'c', 'd', 'e'], 'hi')).toBe('a, b, c, और 2 अन्य');
  });
});
