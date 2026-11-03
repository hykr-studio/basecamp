import type { Lang } from '@hykr/i18n';
import type { ScreenDef, ViewDef } from './define-view.js';
import { platformScreens, platformViews } from './platform/index.js';
import { createRegistry } from './registry.js';

/** What an application adds to the registry: its views and screens. */
export interface UiDomain {
  views: readonly ViewDef[];
  screens: readonly ScreenDef[];
}

/** The system's registry: the framework's own views and screens, plus the application's. */
export function createUiRegistry(ui: UiDomain = { views: [], screens: [] }) {
  return createRegistry({
    views: [...platformViews, ...ui.views],
    screens: [...platformScreens, ...ui.screens],
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
