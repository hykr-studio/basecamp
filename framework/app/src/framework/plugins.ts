import { createElement, type ReactNode, useEffect } from 'react';
import type { SessionUser } from '../session';
import type { AppPlugin, NavItem } from './app-domain';

/** The plugins' providers around `children`, the first plugin outermost. */
export function wrapProviders(plugins: readonly AppPlugin[], children: ReactNode): ReactNode {
  return plugins.reduceRight<ReactNode>(
    (inner, p) => (p.Provider ? createElement(p.Provider, null, inner) : inner),
    children,
  );
}

type Log = (message: string, error: unknown) => void;
const logError: Log = (message, error) => console.error(message, error);

/**
 * Run every plugin's `onSignedIn` for this person; returns the cleanup for sign-out, which
 * runs their cleanups in reverse. A plugin that throws, or whose promise rejects, is logged and
 * skipped: the others still run, and the app keeps going.
 */
export function runSignedIn(
  plugins: readonly AppPlugin[],
  user: SessionUser,
  log: Log = logError,
): () => void {
  const cleanups: { name: string; fn: () => void }[] = [];
  for (const p of plugins) {
    if (!p.onSignedIn) continue;
    const failed = (e: unknown) => log(`App plugin "${p.name}" failed after sign-in:`, e);
    try {
      const out = p.onSignedIn(user);
      if (typeof out === 'function') cleanups.push({ name: p.name, fn: out });
      else if (out && typeof (out as Promise<unknown>).then === 'function')
        (out as Promise<unknown>).then(undefined, failed);
    } catch (e) {
      failed(e);
    }
  }
  return () => {
    for (const c of cleanups.reverse()) {
      try {
        c.fn();
      } catch (e) {
        log(`App plugin "${c.name}" failed at sign-out:`, e);
      }
    }
  };
}

/**
 * Its children, and every plugin's `onSignedIn` for this person while it is mounted (after the
 * children mount); their cleanups when it unmounts or the person changes. The shell renders one,
 * keyed by its installation, around everything signed in, so a new installation cleans up the
 * old plugins' effects before running the new ones. Keep it the only keyed child there: a sibling
 * with the same key would replace it without unmounting it, and its cleanups would never run.
 */
export function SignedIn({
  user,
  plugins,
  children,
}: {
  user: SessionUser;
  plugins: readonly AppPlugin[];
  children?: ReactNode;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per person; the plugins are fixed while it is mounted (a new installation remounts it)
  useEffect(() => runSignedIn(plugins, user), [user.id]);
  return children;
}

/**
 * What a nav filter may return: the given destinations, hidden or reordered. An item it was not
 * given (by href) is dropped, and so is a repeat; the given item is kept as it was.
 */
export function filterNav(given: readonly NavItem[], returned: readonly NavItem[]): NavItem[] {
  const byHref = new Map(given.map((i) => [i.href, i]));
  const out: NavItem[] = [];
  for (const item of returned) {
    const original = byHref.get(item.href);
    if (!original) continue;
    byHref.delete(item.href);
    out.push(original);
  }
  return out;
}

/**
 * The destinations after every plugin's nav filter, in plugin order. A hook: the shell calls it
 * on every render, with the same plugins for as long as it is mounted.
 */
export function useNavFilters(items: readonly NavItem[], plugins: readonly AppPlugin[]) {
  let out: readonly NavItem[] = items;
  // biome-ignore lint/correctness/useHookAtTopLevel: the plugins are fixed while the shell is mounted (a new installation remounts it), so these hooks run in the same order on every render
  for (const p of plugins) if (p.useNav) out = filterNav(out, p.useNav(out));
  return out;
}
