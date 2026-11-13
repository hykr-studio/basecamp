// The languages the fixture speaks: English, Hindi and Telugu, which the framework has phrases
// for and the framework's WhatsApp, voice and scripted-model tests speak. Declared here, as any
// application declares its own; features/languages adds one the framework has no words for.
import { defineLanguages, type LanguageDef } from '@hykr/i18n';

export const hindi: LanguageDef = {
  name: 'हिंदी',
  english: 'Hindi',
  locale: 'hi-IN',
  letters: /[ऀ-ॣ०-९ॱ-ॿ]/,
};
export const telugu: LanguageDef = {
  name: 'తెలుగు',
  english: 'Telugu',
  locale: 'te-IN',
  letters: /[ఀ-౿]/,
};

export const fixtureLanguages = defineLanguages({
  en: { speech: 'en-IN' },
  hi: hindi,
  te: telugu,
});
