// The voice chip offers the application's languages (docs/decisions/HLANG.md), installed with the
// app's configuration.
import { defineLanguages, languages, resetLanguages } from '@hykr/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { configure } from '../config';
import { nextVoiceChoice, voiceChoices } from './choices';

afterEach(resetLanguages);

describe('the voice language chip', () => {
  it("offers Auto, then the languages the app's configuration declares, round again", () => {
    expect(voiceChoices()).toEqual(['auto', 'en']);
    configure({
      languages: defineLanguages({
        de: { name: 'Deutsch', english: 'German' },
        el: { name: 'Ελληνικά', english: 'Greek' },
      }),
    });
    expect(languages().codes).toEqual(['en', 'de', 'el']);
    expect(voiceChoices()).toEqual(['auto', 'en', 'de', 'el']);
    expect(nextVoiceChoice('auto')).toBe('en');
    expect(nextVoiceChoice('el')).toBe('auto');
    // A language no longer offered goes back to the start.
    expect(nextVoiceChoice('hi')).toBe('auto');
  });
});
