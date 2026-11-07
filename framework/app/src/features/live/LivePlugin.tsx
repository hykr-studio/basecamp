import { ApiError } from '@hykr/api-client';
import type { LiveEvent } from '@hykr/contracts';
import { focusManager, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { api } from '../../api';
import type { AppPlugin } from '../../framework/app-domain';
import { getCatalog } from '../../runtime';
import { createInvalidator, liveKeysFor, reconnectDelay } from './keys';
import { emitLiveEvent } from './listeners';

export type LiveOptions = {
  /** Each event, after the framework's own invalidation: refresh what else depends on it. */
  onEvent?: (event: LiveEvent, client: QueryClient) => void;
};

/** Who is signed in, as the plugin's sign-in effect tells its provider. */
let signedIn: string | null = null;
const listeners = new Set<() => void>();
const setSignedIn = (id: string | null) => {
  signedIn = id;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const current = () => signedIn;

/** Native apps: React Query's focus follows the app's foreground (the web has page visibility). */
let focusWired = false;
function wireFocus() {
  if (focusWired || Platform.OS === 'web') return;
  focusWired = true;
  focusManager.setEventListener((handleFocus) => {
    const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
    return () => sub.remove();
  });
}

/**
 * Keep one live stream open while the app is in the foreground: each event invalidates what it
 * touches; every reconnect after the first invalidates everything (events in between are not
 * replayed). Refusals (signed out, no business) stop it. Returns the cleanup.
 */
function runLive(client: QueryClient, options: LiveOptions): () => void {
  let stopped = false;
  let attempt = 0;
  let opened = false;
  let controller: AbortController | undefined;
  let wake: (() => void) | undefined;
  let background = AppState.currentState === 'background';
  const batch = createInvalidator((key) => void client.invalidateQueries({ queryKey: key }));
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const appState = AppState.addEventListener('change', (state) => {
    background = state === 'background';
    if (background) controller?.abort();
    else {
      attempt = 0;
      wake?.();
    }
  });

  void (async () => {
    while (!stopped) {
      if (background) {
        await sleep(60_000);
        continue;
      }
      controller = new AbortController();
      try {
        await api.live((m) => {
          if (m.kind === 'ready') {
            attempt = 0;
            if (opened) void client.invalidateQueries();
            opened = true;
            return;
          }
          batch.add(liveKeysFor(m.event, getCatalog()));
          options.onEvent?.(m.event, client);
          emitLiveEvent(m.event);
        }, controller.signal);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) break;
      }
      if (stopped) break;
      await sleep(reconnectDelay(attempt++));
    }
  })();

  return () => {
    stopped = true;
    controller?.abort();
    wake?.();
    appState.remove();
    batch.cancel();
  };
}

function LiveProvider({ children, options }: { children: ReactNode; options: LiveOptions }) {
  const client = useQueryClient();
  const userId = useSyncExternalStore(subscribe, current, current);
  useEffect(wireFocus, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one stream per person; the options are fixed for the plugin's life
  useEffect(() => (userId ? runLive(client, options) : undefined), [userId, client]);
  return children;
}

/**
 * Live updates: what other people (and the assistant, and WhatsApp) change shows up without a
 * reload. A stream from GET /api/live while someone is signed in and the app is in the
 * foreground; every screen also refetches stale data when the app comes back to the foreground.
 */
export function livePlugin(options: LiveOptions = {}): AppPlugin {
  const Provider = ({ children }: { children: ReactNode }) => (
    <LiveProvider options={options}>{children}</LiveProvider>
  );
  return {
    name: 'live',
    Provider,
    onSignedIn: (user) => {
      setSignedIn(user.id);
      return () => setSignedIn(null);
    },
  };
}
