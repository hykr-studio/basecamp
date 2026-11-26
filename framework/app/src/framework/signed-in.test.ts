// The shell's signed-in subtree, rendered by React's real reconciler: the shell's tree is
// <ChatRuntime><SignedIn key={generation}><Shell /></SignedIn></ChatRuntime>. A new installation
// (a new generation) must run the old plugins' sign-out cleanups before the new ones sign in,
// remount the shell, and log nothing. The repo has no DOM library, so react-dom renders into a
// bare container: the components here render no elements, so React touches nothing else.
import { act, createElement, type ReactNode, useEffect } from 'react';
// @ts-expect-error react-dom ships no types; @types/react-dom would re-key the lockfile's peers. The two calls used are typed below.
import { createRoot as untypedCreateRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../session';
import type { AppPlugin } from './app-domain';
import { SignedIn } from './plugins';

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

const asha = { id: 'u1', name: 'Asha', email: 'asha@example.com' } as SessionUser;
const ravi = { id: 'u2', name: 'Ravi', email: 'ravi@example.com' } as SessionUser;

let log: string[];
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = [];
  errors = vi.spyOn(console, 'error').mockImplementation(noop);
});
afterEach(() => {
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

/** One installation's plugin: its sign-in and sign-out, tagged with the installation. */
const plugin = (gen: number): AppPlugin => ({
  name: 'push',
  onSignedIn: (u) => {
    log.push(`onSignedIn ${gen} ${u.id}`);
    return () => log.push(`cleanup ${gen} ${u.id}`);
  },
});
function Shell({ gen }: { gen: number }) {
  useEffect(() => {
    log.push(`shell mount ${gen}`);
    return () => {
      log.push(`shell unmount ${gen}`);
    };
  }, [gen]);
  return null;
}
const ChatRuntime = ({ children }: { children?: ReactNode }) => children;
const tree = (gen: number, user: SessionUser) =>
  createElement(
    ChatRuntime,
    null,
    createElement(
      SignedIn,
      { key: gen, user, plugins: [plugin(gen)] },
      createElement(Shell, { gen }),
    ),
  );

describe('SignedIn under the shell', () => {
  it('signs in once per installation, after the shell mounts, and not again on a re-render', async () => {
    const root = createRoot(container());
    await act(async () => root.render(tree(1, asha)));
    await act(async () => root.render(tree(1, asha)));
    expect(log).toEqual(['shell mount 1', 'onSignedIn 1 u1']);
    await act(async () => root.unmount());
  });

  it('cleans up the old installation before the new one signs in, and remounts the shell', async () => {
    const root = createRoot(container());
    await act(async () => root.render(tree(1, asha)));
    await act(async () => root.render(tree(2, asha)));
    expect(log).toEqual([
      'shell mount 1',
      'onSignedIn 1 u1',
      'cleanup 1 u1',
      'shell unmount 1',
      'shell mount 2',
      'onSignedIn 2 u1',
    ]);
    await act(async () => root.unmount());
  });

  it('cleans up at sign-out and when the person changes', async () => {
    const root = createRoot(container());
    await act(async () => root.render(tree(1, asha)));
    await act(async () => root.render(tree(1, ravi)));
    expect(log).toEqual(['shell mount 1', 'onSignedIn 1 u1', 'cleanup 1 u1', 'onSignedIn 1 u2']);
    await act(async () => root.render(null));
    expect(log.slice(4)).toEqual(['cleanup 1 u2', 'shell unmount 1']);
    await act(async () => root.unmount());
  });
});
