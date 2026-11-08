// The application's languages (docs/decisions/HLANG.md): the fixture again, speaking a fourth
// language the framework has no phrases for, Greek. The application gives Greek its letters (so
// a Greek message is known to be Greek), its WhatsApp keywords, and its own words for two
// framework phrases; everything else reads in English. Only the languages e2e test boots it.
import { defineServer } from '@hykr/api';
import { defineLanguages } from '@hykr/i18n';
import { fixture } from '../../index.js';
import { hindi, telugu } from '../../languages.js';

export const GREEK_STOPPED = 'Δεν θα λαμβάνετε πια υπενθυμίσεις ή προσφορές εδώ.';
export const GREEK_HANDOFF = 'Κάποιος από την ομάδα θα απαντήσει εδώ, συνήθως μέσα σε {replyTime}.';

export const languagesWithGreek = defineLanguages({
  en: { speech: 'en-IN' },
  hi: hindi,
  te: telugu,
  el: {
    name: 'Ελληνικά',
    english: 'Greek',
    locale: 'el-GR',
    letters: /[Ͱ-Ͽἀ-῿]/,
    keywords: { stop: ['σταμάτα'], help: ['βοήθεια'] },
  },
});

export const languagesApp = defineServer({
  ...fixture.definition,
  languages: languagesWithGreek,
  wording: {
    ...fixture.definition.wording,
    phrases: { el: { 'channel.stopped': GREEK_STOPPED, 'channel.handoff': GREEK_HANDOFF } },
  },
});
