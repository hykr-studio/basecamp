import { afterEach, describe, expect, it } from 'vitest';
import { defineLanguages, resetLanguages, setLanguages } from './lang.js';
import { overridePhrases, resetPhraseOverrides, setTenantPhrases, t } from './messages.js';

afterEach(() => {
  resetPhraseOverrides();
  resetLanguages();
});

describe('phrase overrides (A11)', () => {
  it("the application's words replace the framework's, per language, with placeholders filled", () => {
    overridePhrases({ en: { 'channel.handoff': 'Our team writes back within {replyTime}.' } });
    expect(t('en', 'channel.handoff', { replyTime: '1 hour' })).toBe(
      'Our team writes back within 1 hour.',
    );
    // Another language keeps the framework's words.
    expect(t('hi', 'channel.handoff', { replyTime: '1' })).not.toContain('Our team');
  });

  it("a business's words come first, and a language it left out falls back", () => {
    overridePhrases({ en: { 'channel.handoff': 'App words {replyTime}.' } });
    setTenantPhrases({ 'channel.handoff': { en: 'Business words {replyTime}.' } });
    expect(t('en', 'channel.handoff', { replyTime: 'soon' })).toBe('Business words soon.');
    setTenantPhrases({});
    expect(t('en', 'channel.handoff', { replyTime: 'soon' })).toBe('App words soon.');
  });

  it('refuses an unknown phrase, lost placeholders, and a phrase overridden twice', () => {
    expect(() => overridePhrases({ en: { 'no.such': 'x' } as never })).toThrow(/not a phrase/);
    expect(() => overridePhrases({ en: { 'channel.handoff': 'Soon.' } })).toThrow(/placeholders/);
    overridePhrases({ en: { 'channel.choose': 'Pick' } });
    expect(() => overridePhrases({ en: { 'channel.choose': 'Select' } })).toThrow(/twice/);
  });

  it('words a language the framework has no translation for, and refuses one not declared', () => {
    expect(() => overridePhrases({ el: { 'channel.choose': 'Επιλέξτε' } })).toThrow(
      /"el" is not one of the application's languages/,
    );
    setLanguages(defineLanguages({ el: { name: 'Ελληνικά', english: 'Greek' } }));
    overridePhrases({ el: { 'channel.choose': 'Επιλέξτε' } });
    expect(t('el', 'channel.choose')).toBe('Επιλέξτε');
    // What it did not word reads in English.
    expect(t('el', 'approval.approve')).toBe('Approve');
  });
});
