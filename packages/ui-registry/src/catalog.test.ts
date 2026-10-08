// Whatever domain is installed: every word a view declares exists, non-empty, in every
// language. The types make a missing language fail to compile; this catches an empty one,
// which would otherwise fall back to English without anyone noticing.
import { LANGS } from '@app/i18n';
import { describe, expect, it } from 'vitest';
import { registry } from './catalog.js';

describe('the catalog’s words', () => {
  it('every view label and noun is filled in for every language', () => {
    for (const view of registry.views) {
      const { title, empty, noun } = view.labels;
      for (const lang of LANGS) {
        if (title) expect(title[lang].trim(), `${view.name} title (${lang})`).not.toBe('');
        if (empty) expect(empty[lang].trim(), `${view.name} empty (${lang})`).not.toBe('');
        if (noun)
          for (const form of noun[lang])
            expect(form.trim(), `${view.name} noun (${lang})`).not.toBe('');
      }
    }
  });
});
