// The framework's own views: every word they declare is filled in for every language.
import { LANGS } from '@hykr/i18n';
import { describe, expect, it } from 'vitest';
import { createUiRegistry, emptyLabels } from './catalog.js';

describe('the platform views’ words', () => {
  it('every view label and noun is filled in for every language', () => {
    expect(emptyLabels(createUiRegistry().views, LANGS)).toEqual([]);
  });
});
