import { type Lang, pick } from '@app/i18n';
import type { ComponentType } from 'react';
import type { z } from 'zod';
import type { ScreenDef, ViewDef } from './define-view.js';

/** A view's own words in the person's language: its default title and its empty line. */
export type ViewWords = { title?: string; empty?: string };

/** The renderer passes these, so a component never chooses a language itself. */
export function wordsOf(view: ViewDef, lang: Lang): ViewWords {
  const { title, empty } = view.labels;
  return {
    title: title ? pick(title, lang) : undefined,
    empty: empty ? pick(empty, lang) : undefined,
  };
}

/**
 * What a view's component gets: its props, act(name, item) for its declared actions, and
 * its words in the person's language.
 */
export type ViewProps<V extends ViewDef> = z.infer<V['props']> & {
  act: (action: keyof V['actions'] & string, item: unknown) => void;
  words: ViewWords;
};
export type ScreenProps<S extends ScreenDef> = z.infer<S['params']>;

// biome-ignore lint/suspicious/noExplicitAny: one registry holds components of every view's props
const viewComponents = new Map<string, ComponentType<any>>();
// biome-ignore lint/suspicious/noExplicitAny: as above, for screens
const screenComponents = new Map<string, ComponentType<any>>();

/**
 * Attach this app's component to a view, once at startup. The component's props must be
 * the view's own (checked here by the compiler), so a renamed field fails to build rather
 * than render blank.
 */
export function bindView<V extends ViewDef>(view: V, component: ComponentType<ViewProps<V>>) {
  viewComponents.set(view.name, component);
}

export function bindScreen<S extends ScreenDef>(
  screen: S,
  component: ComponentType<ScreenProps<S>>,
) {
  screenComponents.set(screen.name, component);
}

// biome-ignore lint/suspicious/noExplicitAny: callers render by name with checked props
export const getView = (name: string): ComponentType<any> | undefined => viewComponents.get(name);
// biome-ignore lint/suspicious/noExplicitAny: as above
export const getScreen = (name: string): ComponentType<any> | undefined =>
  screenComponents.get(name);
