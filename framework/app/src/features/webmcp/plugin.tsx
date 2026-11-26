import { type ApiClient, createApiClient } from '@hykr/api-client';
import { CHANNEL_HEADER } from '@hykr/contracts';
import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { authHeaders, credentials } from '../../api';
import { appConfig } from '../../config';
import type { AppPlugin } from '../../framework/app-domain';
import { useAssistant } from '../../framework/assistant-context';
import { getCatalog, webMcpFor } from '../../runtime';
import {
  findModelContext,
  type Log,
  type ModelContextLike,
  registerTools,
  type WebMcpTool,
} from './adapter';
import { webMcpTools } from './tools';

/**
 * The client the tools call through: the app's own (the person's session and business), naming
 * the `webmcp` channel, which the API keeps read-only and out of people-only actions.
 */
export function webMcpClient(): ApiClient {
  return createApiClient({
    get baseUrl() {
      return appConfig().apiUrl;
    },
    credentials,
    headers: async () => ({ ...(await authHeaders()), [CHANNEL_HEADER]: 'webmcp' }),
  });
}

export type WebMcpOptions = {
  /** The browser's model context. Default: `findModelContext()`, read when a screen opens. */
  modelContext?: () => ModelContextLike | undefined;
  /** Default: `webMcpClient()`. */
  client?: ApiClient;
  /** Where a refused registration is reported. Default: console.warn. */
  log?: Log;
};

/**
 * While `enabled`, offer the browser the read tools of the screen the person is on (its
 * `useScreenContext` name, declared in a module's or the app's `webmcp`), and take them back
 * when the screen changes, when disabled and on unmount. No browser support, no declaration
 * or no screen (the canvas, the sign-in screen): no tools.
 */
export function useWebMcpTools(options: WebMcpOptions & { enabled: boolean; client: ApiClient }) {
  const { context } = useAssistant();
  const screen = context?.screen;
  const type = context?.record?.type;
  const id = context?.record?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the screen and its record; the options are fixed for the plugin's life
  useEffect(() => {
    if (!options.enabled || !screen) return;
    const declared = webMcpFor(screen);
    if (!declared) return;
    const mc = (options.modelContext ?? findModelContext)();
    if (!mc) return;
    const log = options.log ?? ((m: string, e?: unknown) => console.warn(m, e));
    let tools: WebMcpTool[];
    try {
      tools = webMcpTools({
        catalog: getCatalog(),
        reads: declared.reads,
        client: options.client,
        context: { screen, ...(type && id ? { record: { type, id } } : {}) },
      });
    } catch (e) {
      // A spec whose tools cannot be built here (a list field type this process never defined):
      // no tools on this screen, and the app goes on.
      log(`WebMCP: no tools for the screen ${screen}`, e);
      return;
    }
    return registerTools(mc, tools, log);
  }, [options.enabled, screen, type, id]);
}

/** Who is signed in, for this plugin: set by its onSignedIn, cleared by its cleanup. */
function signedInStore() {
  let userId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    set(next: string | null) {
      userId = next;
      for (const listener of listeners) listener();
    },
    get: () => userId,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * WebMCP for the app: each screen's declared read tools, offered to the browser's agent while a
 * signed-in person is on that screen, behind feature detection. List it in `<AppShell plugins>`.
 * Signed out, on public routes and in native apps it offers nothing.
 */
export function webMcpPlugin(options: WebMcpOptions = {}): AppPlugin {
  const session = signedInStore();
  let client = options.client;
  const clientOf = () => {
    client ??= webMcpClient();
    return client;
  };
  function WebMcpTools({ children }: { children: ReactNode }) {
    const userId = useSyncExternalStore(session.subscribe, session.get, session.get);
    useWebMcpTools({ ...options, enabled: userId !== null, client: clientOf() });
    return children;
  }
  return {
    name: 'webmcp',
    Provider: WebMcpTools,
    onSignedIn: (user) => {
      session.set(user.id);
      return () => session.set(null);
    },
  };
}
