import { describe, expect, it } from 'vitest';
import {
  catalogs,
  count,
  dayText,
  firstFew,
  LANGS,
  langOf,
  type Noun,
  scriptOf,
  t,
  whenText,
} from './index.js';

const todo: Noun = { en: ['to-do', 'to-dos'], hi: ['काम', 'काम'], te: ['పని', 'పనులు'] };

describe('catalogs', () => {
  it('every phrase exists, non-empty, in every language, with the same placeholders', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, phrase] of Object.entries(catalogs.en)) {
      for (const lang of LANGS) {
        const local = catalogs[lang][key as keyof typeof catalogs.en];
        expect(local, `${lang}.${key}`).toBeTruthy();
        expect(vars(local), `${lang}.${key}`).toEqual(vars(phrase));
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

  it('counts with the language’s plural', () => {
    expect(count(1, todo)).toBe('1 to-do');
    expect(count(3, todo)).toBe('3 to-dos');
    expect(count(3, todo, 'te')).toBe('3 పనులు');
    expect(count(1, todo, 'hi')).toBe('1 काम');
  });

  it('names the first few, then how many more', () => {
    expect(firstFew(['a', 'b'])).toBe('a, b');
    expect(firstFew(['a', 'b', 'c', 'd', 'e'], 'hi')).toBe('a, b, c, और 2 अन्य');
  });
});
