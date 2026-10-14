import { describe, expect, it } from 'vitest';
import { LangState } from './lang.js';

describe('LangState', () => {
  it('pinned: never moves, and asks STT for that language', () => {
    const s = new LangState('te-IN');
    expect(s.hear('add Call the plumber please now', 'en-IN')).toBe('te');
    expect(s.sttLanguage).toBe('te-IN');
    expect(s.ttsLanguage).toBe('te-IN');
  });

  it('auto: a clear sentence in another language switches at once', () => {
    const s = new LangState('auto');
    expect(s.sttLanguage).toBe('unknown');
    expect(s.hear('నాకు రేపు ప్లంబర్‌ని పిలవాలి', 'te-IN')).toBe('te');
    expect(s.ttsLanguage).toBe('te-IN');
  });

  it('auto: sticky against a short or code-mixed word, but follows two in a row', () => {
    const s = new LangState('auto');
    s.hear('నాకు రేపు ప్లంబర్‌ని పిలవాలి');
    expect(s.hear('ok', 'en-IN')).toBe('te');
    expect(s.hear('జాబితా')).toBe('te');
    expect(s.hear('yes', 'en-IN')).toBe('te');
    expect(s.hear('thanks', 'en-IN')).toBe('en');
  });

  it('a pin from the chip, then back to auto', () => {
    const s = new LangState('auto');
    s.pin('hi-IN');
    expect(s.hear('add tiles to my list', 'en-IN')).toBe('hi');
    s.pin('auto');
    expect(s.isPinned).toBe(false);
    expect(s.hear('add tiles to my list', 'en-IN')).toBe('en');
  });
});
