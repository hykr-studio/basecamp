// The application's languages at boot (docs/decisions/HLANG.md), without booting: defineServer
// keeps the declaration (English alone without one), installs it with the runtime, and refuses
// every word keyed by a language it does not declare, a voice eval case in one, and keywords for
// no keyword, in one ModulesError. A missing language is fine: it reads in English.
import { entitySpec, ModulesError } from '@hykr/contracts';
import { defineLanguages, languages } from '@hykr/i18n';
import { defineTemplate } from '@hykr/notifications';
import { defineView } from '@hykr/ui-registry';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineMeter, defineModule, defineServer, type ModuleDef } from '../../dist/index.js';

const Row = z.object({ id: z.string(), title: z.string() });
const german = defineLanguages({ de: { name: 'Deutsch', english: 'German' } });

const mod = (name: string, extra: Partial<ModuleDef> = {}): ModuleDef =>
  defineModule({
    name,
    entities: {
      [`${name}s`]: entitySpec({
        name,
        label: name,
        description: `${name}s.`,
        schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
        fieldLabels: { title: { en: 'Title', de: 'Titel' } },
        list: {
          filterable: {},
          sortable: [],
          defaultSort: [],
          search: [],
          pageSize: { default: 10, max: 10 },
        },
      }),
    },
    commands: [],
    ...extra,
  });

const view = (name: string) =>
  defineView({
    name: `${name}.list`,
    description: 'Things.',
    surfaces: ['inline'],
    props: z.object({}),
    labels: { title: { en: 'Things', fr: 'Choses' }, empty: { en: 'None.' } },
    text: () => '',
    speak: () => '',
  });

function problems(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ModulesError) return error.problems;
    throw error;
  }
  throw new Error('expected a ModulesError');
}

describe('the languages a server speaks', () => {
  it('are its declaration, or English alone; a word missing in one is fine', () => {
    const plain = defineServer({ name: 'T', persona: 'You test.', modules: [] });
    expect(plain.languages.codes).toEqual(['en']);
    const app = defineServer({
      name: 'T',
      persona: 'You test.',
      languages: german,
      channel: { does: { en: 'I help.' } },
      modules: [mod('lang_ok')],
    });
    expect(app.languages).toBe(german);
    // Defining a server installs nothing: the runtime does, when the process serves it.
    expect(languages().codes).toEqual(['en']);
  });

  it('refuses every word in a language it does not declare, and keywords for no keyword', () => {
    const template = defineTemplate({
      name: 'lang_hello_v1',
      category: 'utility',
      params: z.object({ name: z.string() }),
      body: { en: 'Hi {{name}}', fr: 'Salut {{name}}' },
      example: { name: 'Ana' },
    });
    const found = problems(() =>
      defineServer({
        name: 'T',
        persona: 'You test.',
        languages: defineLanguages({
          de: { name: 'Deutsch', english: 'German', keywords: { halt: ['halt'] } },
        }),
        channel: { does: { en: 'I help.', fr: 'Je vous aide.' } },
        modules: [
          mod('lang_bad', {
            views: [view('lang_bad')],
            templates: [template],
            agent: {
              voiceEvalCases: [
                { lang: 'fr', why: 'a French turn', input: 'bonjour', expect: { must: [] } },
              ],
            },
          }),
        ],
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        `channel.does is in "fr", not one of the application's languages`,
        expect.stringMatching(/The language de has words for "halt", which is not a keyword/),
        `The view lang_bad.list's title is in "fr", not one of the languages`,
        `lang_bad: the template lang_hello_v1's body is in "fr", not one of the application's languages`,
        `lang_bad: the voice eval case "a French turn" is in "fr", not one of the application's languages`,
      ]),
    );
    // German is declared: the field label in German is not a problem.
    expect(found.some((p) => p.includes('lang_bad.title'))).toBe(false);
  });

  it("refuses a meter's label in a language it does not declare, from a module or the server", () => {
    const meter = (name: string) =>
      defineMeter({ name, unit: 'page', label: { en: 'Pages', hn: 'पेज' } as never });
    const found = problems(() =>
      defineServer({
        name: 'T',
        persona: 'p',
        languages: german,
        modules: [mod('lang_meter', { contributes: { meters: [meter('lang_pages')] } })],
        contributes: { meters: [meter('lang_server_pages')] },
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        `lang_meter: the meter lang_pages's label is in "hn", not one of the application's languages`,
        `the server: the meter lang_server_pages's label is in "hn", not one of the application's languages`,
      ]),
    );
  });

  it('refuses a field label in a language it does not declare', () => {
    expect(
      problems(() => defineServer({ name: 'T', persona: 'p', modules: [mod('lang_fl')] })),
    ).toEqual([
      `lang_fl: lang_fl.title's label is in "de", not one of the application's languages`,
    ]);
  });
});
