// The WebMCP plugin under the shell's providers, rendered by React's real reconciler into a bare
// container (as framework/signed-in.test.ts does): a screen's declared read tools are offered
// while a signed-in person is on it, and taken back when that changes.
import type { ChatContext } from '@hykr/contracts';
import { createCatalog, defineDomain, entitySpec } from '@hykr/contracts';
import { createUiRegistry } from '@hykr/ui-registry';
import { act, createElement, type ReactNode } from 'react';
// @ts-expect-error react-dom ships no types; @types/react-dom would re-key the lockfile's peers. The two calls used are typed below.
import { createRoot as untypedCreateRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configure } from '../../config';
import { defineAppModule } from '../../framework/app-domain';
import { AssistantProvider, useScreenContext } from '../../framework/assistant-context';
import { composeApp } from '../../framework/compose-app';
import { SignedIn, wrapProviders } from '../../framework/plugins';
import { setRuntime } from '../../runtime';
import type { SessionUser } from '../../session';
import type { ModelContextLike, WebMcpTool } from './adapter';
import { webMcpClient, webMcpPlugin } from './plugin';

type Root = { render(node: ReactNode): void; unmount(): void };
const createRoot = untypedCreateRoot as (container: unknown) => Root;

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, act: g.IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  g.window = { event: undefined, HTMLIFrameElement: class {} };
  g.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  g.window = saved.window;
  g.IS_REACT_ACT_ENVIRONMENT = saved.act;
});

const noop = () => {};
const container = () => {
  const doc = { nodeType: 9, addEventListener: noop, removeEventListener: noop };
  return {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: doc,
    addEventListener: noop,
    removeEventListener: noop,
    firstChild: null,
    removeChild: noop,
    appendChild: noop,
    insertBefore: noop,
    textContent: '',
  };
};

const Row = z.object({ id: z.string(), title: z.string() });
const spec = (name: string) =>
  entitySpec({
    name,
    label: name,
    description: `Test ${name}s.`,
    schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
    list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 20, max: 100 } },
  });
// A list filter on a field type this process never defined: its tools cannot be built.
const broken = {
  ...spec('draft'),
  list: { ...spec('draft').list, filterable: { title: 'undefinedType' as 'text' } },
};
const catalog = createCatalog(
  defineDomain({
    name: 'Fixture',
    entities: { records: spec('record'), cards: spec('card'), drafts: broken },
    commands: [],
  }),
);
const records = defineAppModule({
  name: 'records',
  webmcp: {
    records: { reads: ['records'] },
    record: { reads: ['records', 'cards'] },
    drafts: { reads: ['drafts'] },
  },
});
const app = { title: 'Fixture', tagline: 'One module', webmcp: { home: { reads: ['cards'] } } };

beforeAll(() => {
  setRuntime({
    catalog,
    registry: createUiRegistry(),
    app: composeApp({ app, modules: [records], catalog }),
  });
});

/** The browser's model context: the tools registered now. */
function browser() {
  const tools = new Map<string, WebMcpTool>();
  const mc: ModelContextLike = {
    registerTool: (t: WebMcpTool, options?: { signal?: AbortSignal }) => {
      if (tools.has(t.name)) throw new Error(`Duplicate ${t.name}`);
      tools.set(t.name, t);
      options?.signal?.addEventListener('abort', () => tools.delete(t.name));
    },
  };
  return { mc, names: () => [...tools.keys()], tools };
}

const asha = { id: 'u1', name: 'Asha', email: 'asha@example.com' } as SessionUser;
const client = webMcpClient();

function Screen({ context }: { context?: ChatContext }) {
  useScreenContext(context);
  return null;
}

/** The shell's shape: the assistant's provider, the plugins' providers, then signed in or not. */
function tree(
  plugin: ReturnType<typeof webMcpPlugin>,
  user: SessionUser | null,
  context?: ChatContext,
) {
  const screen = createElement(Screen, { context });
  return createElement(
    AssistantProvider,
    null,
    wrapProviders(
      [plugin],
      user ? createElement(SignedIn, { key: 1, user, plugins: [plugin] }, screen) : screen,
    ),
  );
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(noop);
});
afterEach(() => {
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
  vi.unstubAllGlobals();
});

describe('webMcpPlugin', () => {
  it('offers nothing signed out, even on a declared screen', async () => {
    const b = browser();
    const plugin = webMcpPlugin({ modelContext: () => b.mc, client });
    const root = createRoot(container());
    await act(async () => root.render(tree(plugin, null, { screen: 'records' })));
    expect(b.names()).toEqual([]);
    await act(async () => root.unmount());
  });

  it("offers the screen's tools to a signed-in person, and swaps them when the screen changes", async () => {
    const b = browser();
    const plugin = webMcpPlugin({ modelContext: () => b.mc, client });
    const root = createRoot(container());
    await act(async () => root.render(tree(plugin, asha, { screen: 'records' })));
    expect(b.names()).toEqual(['list-records', 'get-record']);
    expect(b.tools.get('list-records')?.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });

    const id = '7f0c2c63-8a4f-4b6c-9a3e-1d2b3c4d5e6f';
    await act(async () =>
      root.render(tree(plugin, asha, { screen: 'record', record: { type: 'record', id } })),
    );
    expect(b.names()).toEqual(['list-records', 'get-record', 'list-cards', 'get-card']);
    expect(b.tools.get('get-record')?.description).toContain(id);

    // The application's own screen.
    await act(async () => root.render(tree(plugin, asha, { screen: 'home' })));
    expect(b.names()).toEqual(['list-cards', 'get-card']);
    await act(async () => root.unmount());
    expect(b.names()).toEqual([]);
  });

  it('offers nothing on an undeclared screen or without a screen (the canvas)', async () => {
    const b = browser();
    const plugin = webMcpPlugin({ modelContext: () => b.mc, client });
    const root = createRoot(container());
    await act(async () => root.render(tree(plugin, asha, { screen: 'settings' })));
    expect(b.names()).toEqual([]);
    await act(async () => root.render(tree(plugin, asha, { screen: 'records' })));
    expect(b.names()).toHaveLength(2);
    await act(async () => root.render(tree(plugin, asha, undefined)));
    expect(b.names()).toEqual([]);
    await act(async () => root.unmount());
  });

  it('takes the tools back at sign-out', async () => {
    const b = browser();
    const plugin = webMcpPlugin({ modelContext: () => b.mc, client });
    const root = createRoot(container());
    await act(async () => root.render(tree(plugin, asha, { screen: 'records' })));
    expect(b.names()).toHaveLength(2);
    await act(async () => root.render(tree(plugin, null, { screen: 'records' })));
    expect(b.names()).toEqual([]);
    await act(async () => root.unmount());
  });

  it('logs a screen whose tools cannot be built, and the app goes on', async () => {
    const b = browser();
    const log = vi.fn();
    const plugin = webMcpPlugin({ modelContext: () => b.mc, client, log });
    const root = createRoot(container());
    await act(async () => root.render(tree(plugin, asha, { screen: 'drafts' })));
    expect(b.names()).toEqual([]);
    expect(log).toHaveBeenCalledWith('WebMCP: no tools for the screen drafts', expect.any(Error));
    await act(async () => root.render(tree(plugin, asha, { screen: 'records' })));
    expect(b.names()).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it('does nothing without the browser API (native apps, other browsers)', async () => {
    const plugin = webMcpPlugin({ modelContext: () => undefined, client });
    const root = createRoot(container());
    await act(async () => root.render(tree(plugin, asha, { screen: 'records' })));
    await act(async () => root.unmount());
    // And the default detection finds none in this process.
    const byDefault = webMcpPlugin();
    const again = createRoot(container());
    await act(async () => again.render(tree(byDefault, asha, { screen: 'records' })));
    await act(async () => again.unmount());
  });

  it("calls the API as the person, on the webmcp channel, at the app's address", async () => {
    configure({ apiUrl: 'https://api.test' });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    });
    const b = browser();
    const plugin = webMcpPlugin({ modelContext: () => b.mc });
    const root = createRoot(container());
    await act(async () => root.render(tree(plugin, asha, { screen: 'records' })));
    const out = await b.tools.get('list-records')?.execute({});
    expect(JSON.parse(out as string)).toMatchObject({ ok: true });
    expect(calls[0].url).toBe('https://api.test/api/records?limit=20');
    expect(calls[0].init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      headers: { 'x-channel': 'webmcp' },
    });
    await act(async () => root.unmount());
  });
});
