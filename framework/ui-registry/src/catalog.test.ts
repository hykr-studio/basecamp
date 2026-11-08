// The framework's own views: every word they declare is filled in, in English and in each
// translation they ship; a word in a language the application does not speak is reported.
import { defineLanguages } from '@hykr/i18n';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createUiRegistry, languageProblems, missingLabels } from './catalog.js';
import { defineView } from './define-view.js';

const view = (labels: Parameters<typeof defineView>[0]['labels']) =>
  defineView({
    name: 'thing.list',
    description: 'Things.',
    surfaces: ['inline'],
    props: z.object({}),
    labels,
    text: () => '',
    speak: () => '',
  });

describe('the platform views’ words', () => {
  it('every view label and noun is filled in, in English and in the translations it ships', () => {
    expect(missingLabels(createUiRegistry().views, ['en', 'hi', 'te'])).toEqual([]);
  });
});

describe('missingLabels and languageProblems', () => {
  const things = view({
    title: { en: 'Things', de: 'Dinge' },
    empty: { en: 'No things.', de: ' ' },
    noun: { en: ['thing', 'things'] },
  });

  it('lists each word missing or empty in a language asked for', () => {
    expect(missingLabels([things], ['en'])).toEqual([]);
    expect(missingLabels([things], ['en', 'de'])).toEqual([
      'thing.list empty (de)',
      'thing.list noun (de)',
    ]);
  });

  it('reports words in a language the application does not declare', () => {
    expect(languageProblems([things], defineLanguages({}))).toEqual([
      'The view thing.list\'s title is in "de", not one of the languages',
      'The view thing.list\'s empty is in "de", not one of the languages',
    ]);
    expect(
      languageProblems([things], defineLanguages({ de: { name: 'Deutsch', english: 'German' } })),
    ).toEqual([]);
  });
});
