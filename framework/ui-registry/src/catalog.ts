import { assertNoProblems, type EntitySpec, PLATFORM_MODULE } from '@hykr/contracts';
import type { Lang } from '@hykr/i18n';
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

/**
 * Every word a view declares exists, non-empty, in every language. The types make a missing
 * language fail to compile; this catches an empty one, which would otherwise fall back to
 * English without anyone noticing. An application runs it in its own tests.
 */
export function emptyLabels(views: readonly ViewDef[], langs: readonly Lang[]): string[] {
  const problems: string[] = [];
  for (const view of views) {
    const { title, empty, noun } = view.labels;
    for (const lang of langs) {
      if (title && !title[lang].trim()) problems.push(`${view.name} title (${lang})`);
      if (empty && !empty[lang].trim()) problems.push(`${view.name} empty (${lang})`);
      if (noun)
        for (const form of noun[lang])
          if (!form.trim()) problems.push(`${view.name} noun (${lang})`);
    }
  }
  return problems;
}
