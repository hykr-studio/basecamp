// Where the person is in the app, kept while the shell draws its screens again. A plugin's redraw
// key (the business's colours arriving after sign-in) remounts the shell's layout and with it the
// navigator, which then starts again at its first route: a link the person opened (an approval
// from an email or an MCP client, a record) would land on the home screen. The shell keeps the
// place before it redraws, and the new layout goes back to it once its navigator is ready.
import {
  router,
  useGlobalSearchParams,
  usePathname,
  useRootNavigationState,
  useSegments,
} from 'expo-router';
import { useEffect } from 'react';

type Params = Readonly<Record<string, string | string[] | undefined>>;

/**
 * The place as an href: the path, and the query it was opened with. Expo Router's params mix the
 * route's own segments (`[id]`) with the query; those segments are already in the path.
 */
export function hrefOf(pathname: string, params: Params, segments: readonly string[]): string {
  const inPath = new Set(
    segments.flatMap((s) => {
      const m = /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(s);
      return m ? [m[1]] : [];
    }),
  );
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (inPath.has(key) || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) query.append(key, v);
  }
  const search = query.toString();
  return search ? `${pathname}?${search}` : pathname;
}

/** Where the person is now, as an href. */
export function useHere(): string {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const segments = useSegments();
  return hrefOf(pathname, params, segments);
}

let kept: string | null = null;

/** Called by the shell just before it draws its screens again: it comes back here. */
export function keepPlace(href: string) {
  kept = href;
}

/** The kept place, once: null when none was kept (or it was already taken). */
export function takeKeptPlace(): string | null {
  const to = kept;
  kept = null;
  return to;
}

/** In the shell's layout: once its navigator is ready, back to the place kept before a redraw. */
export function useReturnToKeptPlace() {
  const ready = useRootNavigationState()?.key;
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the navigator is ready; the path is read then
  useEffect(() => {
    if (!ready) return;
    const to = takeKeptPlace();
    if (to && to.split('?')[0] !== pathname) router.replace(to as never);
  }, [ready]);
}
