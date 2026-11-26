import { type Lang, pick } from '@hykr/i18n';
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

type Bound = {
  // biome-ignore lint/suspicious/noExplicitAny: one registry holds components of every view's props
  component: ComponentType<any>;
  /** Who bound it ('framework', a module's name), for the duplicate message. */
  owner: string;
};
const viewComponents = new Map<string, Bound>();
const screenComponents = new Map<string, Bound>();

let owner: string | undefined;

/**
 * Bind as `name` while `fn` runs: a duplicate binding then says who bound each one ("by
 * meetings and by notes"). The app shell binds the framework's components as 'framework' and
 * each app module's as the module's name.
 */
export function bindingAs<T>(name: string, fn: () => T): T {
  const before = owner;
  owner = name;
  try {
    return fn();
  } finally {
    owner = before;
  }
}

function bind(
  kind: 'view' | 'screen',
  map: Map<string, Bound>,
  name: string,
  c: Bound['component'],
) {
  const by = owner ?? 'the app';
  const taken = map.get(name);
  if (taken)
    throw new Error(`The ${kind} "${name}" is bound twice (by ${taken.owner} and by ${by})`);
  map.set(name, { component: c, owner: by });
}

/**
 * Attach this app's component to a view, once at startup. The component's props must be
 * the view's own (checked here by the compiler), so a renamed field fails to build rather
 * than render blank. A view has one component: binding a bound name again throws.
 */
export function bindView<V extends ViewDef>(view: V, component: ComponentType<ViewProps<V>>) {
  bind('view', viewComponents, view.name, component);
}

/** Attach this app's component to a screen, once at startup. A second binding throws. */
export function bindScreen<S extends ScreenDef>(
  screen: S,
  component: ComponentType<ScreenProps<S>>,
) {
  bind('screen', screenComponents, screen.name, component);
}

/**
 * Forget every binding. The app shell calls it before binding again, when the app it runs is
 * replaced (Fast Refresh in development); nothing else should need it.
 */
export function clearBindings() {
  viewComponents.clear();
  screenComponents.clear();
}

/** The names of the bound views and screens, for checking them against the registry. */
export const boundViews = (): string[] => [...viewComponents.keys()];
export const boundScreens = (): string[] => [...screenComponents.keys()];

// biome-ignore lint/suspicious/noExplicitAny: callers render by name with checked props
export const getView = (name: string): ComponentType<any> | undefined =>
  viewComponents.get(name)?.component;
// biome-ignore lint/suspicious/noExplicitAny: as above
export const getScreen = (name: string): ComponentType<any> | undefined =>
  screenComponents.get(name)?.component;
