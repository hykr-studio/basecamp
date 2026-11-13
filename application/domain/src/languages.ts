/**
 * The languages this application speaks (`@application/domain/languages`): English, Hindi and
 * Telugu. Isomorphic: the server gives it to `defineServer({ languages })` and the app to
 * `<AppShell config={{ languages }}>`, so both speak the same ones. Every word the modules
 * declare is in these three; a word left out of one would read in English.
 */
import { defineLanguages } from '@hykr/i18n';

export const languages = defineLanguages({
  // Day-month dates and a 24-hour clock; Sarvam hears and speaks Indian English.
  en: { locale: 'en-GB', speech: 'en-IN' },
  hi: {
    name: 'हिंदी',
    english: 'Hindi',
    locale: 'hi-IN',
    // Devanagari letters: the dandas (। ॥) and the abbreviation sign (॰) are punctuation.
    letters: /[ऀ-ॣ०-९ॱ-ॿ]/,
  },
  te: { name: 'తెలుగు', english: 'Telugu', locale: 'te-IN', letters: /[ఀ-౿]/ },
});
