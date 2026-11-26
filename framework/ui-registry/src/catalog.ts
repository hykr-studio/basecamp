import { assertNoProblems, type EntitySpec, PLATFORM_MODULE } from '@hykr/contracts';
import type { Labels, Lang, Languages, Noun } from '@hykr/i18n';
import type { ScreenDef, ViewDef } from './define-view.js';
import { platformScreens, platformViews } from './platform/index.js';
import { createRegistry } from './registry.js';

/** What an application adds to the registry: its views and screens. */
export interface UiDomain {
  views: readonly ViewDef[];
  screens: readonly ScreenDef[];
}

/** One module's views and screens, under its name: what `createUiRegistry` takes per module. */
export interface UiPart {
  /** The module's name ('todos'): `registry.moduleOf` answers with it. */
  name?: string;
  views?: readonly ViewDef[];
  screens?: readonly ScreenDef[];
  /** Its entities (a module's, keyed by plural): views that name an entity are checked against them. */
  entities?: Readonly<Record<string, EntitySpec>>;
}

/**
 * The system's registry: the framework's own views and screens, plus each module's. A view or
 * screen name declared twice throws (a ModulesError naming both owners) instead of the later one
 * replacing the earlier.
 */
export function createUiRegistry(...parts: readonly (UiPart | undefined)[]) {
  const owners = new Map<string, string>();
  const problems: string[] = [];
  const all = [
    { name: PLATFORM_MODULE, views: platformViews, screens: platformScreens },
    ...parts.filter((p): p is UiPart => p !== undefined),
  ];
  for (const part of all) {
    const module = part.name ?? 'the application';
    for (const [kind, defs] of [
      ['view', part.views ?? []],
      ['screen', part.screens ?? []],
    ] as const)
      for (const def of defs) {
        const taken = owners.get(`${kind}:${def.name}`);
        if (taken === undefined) owners.set(`${kind}:${def.name}`, module);
        else problems.push(`The ${kind} ${def.name} is declared by both ${taken} and ${module}`);
      }
  }
  assertNoProblems(problems);
  const given = parts.filter((p): p is UiPart => p?.entities !== undefined);
  return createRegistry({
    views: all.flatMap((p) => p.views ?? []),
    screens: all.flatMap((p) => p.screens ?? []),
    entities: given.length ? given.flatMap((p) => Object.values(p.entities ?? {})) : undefined,
    moduleOf: (name) => owners.get(`view:${name}`) ?? owners.get(`screen:${name}`),
  });
}

/** A view's words, each with the name a problem calls it by. */
function wordsOf(view: ViewDef): [string, Labels | Noun][] {
  const { title, empty, noun } = view.labels;
  return [
    ...(title ? [['title', title] as [string, Labels]] : []),
    ...(empty ? [['empty', empty] as [string, Labels]] : []),
    ...(noun ? [['noun', noun] as [string, Noun]] : []),
  ];
}

const filled = (words: string | readonly string[] | undefined) =>
  words !== undefined && (typeof words === 'string' ? [words] : words).every((w) => w.trim());

/**
 * Every word a view declares, in each of these languages: what is missing or empty. A missing
 * language reads in English, so nothing fails; an application that wants each of its languages
 * complete runs this in its own tests (`missingLabels(views, languages.codes)`).
 */
export function missingLabels(views: readonly ViewDef[], langs: readonly Lang[]): string[] {
  const problems: string[] = [];
  for (const view of views)
    for (const [what, words] of wordsOf(view))
      for (const lang of langs)
        if (!filled(words[lang])) problems.push(`${view.name} ${what} (${lang})`);
  return problems;
}

/**
 * Words in a language the application does not declare: a typo ('hu' for 'hi') or a language
 * it does not speak, either way never shown. `defineServer` reports them before it serves.
 */
export function languageProblems(views: readonly ViewDef[], set: Languages): string[] {
  const problems: string[] = [];
  for (const view of views)
    for (const [what, words] of wordsOf(view))
      for (const lang of Object.keys(words))
        if (!set.has(lang))
          problems.push(
            `The view ${view.name}'s ${what} is in "${lang}", not one of the languages`,
          );
  return problems;
}
