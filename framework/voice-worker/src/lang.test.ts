import { defineLanguages, languagesFromWire } from '@hykr/i18n';
import { describe, expect, it } from 'vitest';
import { LangState } from './lang.js';

// The languages a session speaks, as its dispatch carries them: an application's declaration.
const set = languagesFromWire(
  defineLanguages({
    en: { speech: 'en-IN' },
    hi: {
      name: 'हिंदी',
      english: 'Hindi',
      locale: 'hi-IN',
      letters: /[ऀ-ॣ०-९ॱ-ॿ]/,
    },
    te: { name: 'తెలుగు', english: 'Telugu', locale: 'te-IN', letters: /[ఀ-౿]/ },
  }).toWire(),
);

describe('LangState', () => {
  it('pinned: never moves, and asks STT for that language’s speech tag', () => {
    const s = new LangState('te', set);
    expect(s.hear('add Call the plumber please now', 'en-IN')).toBe('te');
    expect(s.sttLanguage).toBe('te-IN');
    expect(s.ttsLanguage).toBe('te-IN');
  });

  it('auto: a clear sentence in another language switches at once', () => {
    const s = new LangState('auto', set);
    expect(s.sttLanguage).toBe('unknown');
    expect(s.ttsLanguage).toBe('en-IN');
    expect(s.hear('నాకు రేపు ప్లంబర్‌ని పిలవాలి', 'te-IN')).toBe('te');
    expect(s.ttsLanguage).toBe('te-IN');
  });

  it('auto: sticky against a short or code-mixed word, but follows two in a row', () => {
    const s = new LangState('auto', set);
    s.hear('నాకు రేపు ప్లంబర్‌ని పిలవాలి');
    expect(s.hear('ok', 'en-IN')).toBe('te');
    expect(s.hear('జాబితా')).toBe('te');
    expect(s.hear('yes', 'en-IN')).toBe('te');
    expect(s.hear('thanks', 'en-IN')).toBe('en');
  });

  it('a pin from the chip, then back to auto', () => {
    const s = new LangState('auto', set);
    expect(s.pin('hi')).toBe(true);
    expect(s.hear('add tiles to my list', 'en-IN')).toBe('hi');
    s.pin('auto');
    expect(s.isPinned).toBe(false);
    expect(s.hear('add tiles to my list', 'en-IN')).toBe('en');
  });

  it('only the session’s languages: another is never pinned nor heard', () => {
    const s = new LangState('el', set);
    expect(s.isPinned).toBe(false);
    expect(s.pin('el')).toBe(false);
    // A language speech-to-text detected that the application does not speak: the letters decide.
    expect(s.hear('γεια σου τι κάνεις', 'el-GR')).toBe('en');
    const english = new LangState('hi');
    expect(english.isPinned).toBe(false);
    expect(english.hear('हटाओ यह काम अभी', 'hi-IN')).toBe('en');
  });
});
