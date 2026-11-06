// The shell's plugin slots, without rendering: providers nest in order, sign-in effects are
// isolated from each other, and nav filters only hide or reorder.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../session';
import type { AppPlugin, NavItem } from './app-domain';
import { filterNav, runSignedIn, useNavFilters, wrapProviders } from './plugins';

const user = { id: 'u1', name: 'Asha', email: 'asha@example.com' } as SessionUser;
const Outer = ({ children }: { children: ReactNode }) => children;
const Inner = ({ children }: { children: ReactNode }) => children;

describe('wrapProviders', () => {
  it('nests the providers, the first plugin outermost, and skips plugins without one', () => {
    const leaf = createElement('leaf');
    const tree = wrapProviders(
      [{ name: 'a', Provider: Outer }, { name: 'b' }, { name: 'c', Provider: Inner }],
      leaf,
    ) as ReactElement<{ children: ReactElement<{ children: ReactNode }> }>;
    expect(tree.type).toBe(Outer);
    expect(tree.props.children.type).toBe(Inner);
    expect(tree.props.children.props.children).toBe(leaf);
  });
  it('returns the children as they are with no provider', () => {
    const leaf = createElement('leaf');
    expect(wrapProviders([{ name: 'a' }], leaf)).toBe(leaf);
    expect(isValidElement(wrapProviders([], leaf))).toBe(true);
  });
});

describe('runSignedIn', () => {
  it('runs every plugin for the person and their cleanups in reverse at sign-out', () => {
    const calls: string[] = [];
    const plugins: AppPlugin[] = [
      {
        name: 'a',
        onSignedIn: (u) => {
          calls.push(`a:${u.id}`);
          return () => calls.push('a:off');
        },
      },
      { name: 'b' },
      {
        name: 'c',
        onSignedIn: () => {
          calls.push('c');
          return () => calls.push('c:off');
        },
      },
    ];
    const off = runSignedIn(plugins, user);
    expect(calls).toEqual(['a:u1', 'c']);
    off();
    expect(calls).toEqual(['a:u1', 'c', 'c:off', 'a:off']);
  });

  it('logs a plugin that throws or rejects, and still runs the others', async () => {
    const log = vi.fn();
    const ran = vi.fn();
    const off = runSignedIn(
      [
        {
          name: 'broken',
          onSignedIn: () => {
            throw new Error('no token');
          },
        },
        { name: 'async', onSignedIn: () => Promise.reject(new Error('offline')) },
        { name: 'fine', onSignedIn: ran },
        {
          name: 'leaky',
          onSignedIn: () => () => {
            throw new Error('cleanup');
          },
        },
      ],
      user,
      log,
    );
    expect(ran).toHaveBeenCalledWith(user);
    await Promise.resolve();
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'App plugin "broken" failed after sign-in:',
      'App plugin "async" failed after sign-in:',
    ]);
    off();
    expect(log.mock.calls.at(-1)?.[0]).toBe('App plugin "leaky" failed at sign-out:');
  });
});

describe('nav filters', () => {
  const dest = (href: string, module?: string): NavItem => ({
    href,
    label: href,
    icon: 'sun',
    match: () => false,
    module,
  });
  const nav = [dest('/'), dest('/orders', 'orders'), dest('/visits', 'visits'), dest('/pages')];

  it('lets a filter hide and reorder, and drops what it adds or repeats', () => {
    const added = dest('/admin');
    const out = filterNav(nav, [nav[2], nav[0], added, nav[2], { ...nav[3], label: 'Changed' }]);
    expect(out).toEqual([nav[2], nav[0], nav[3]]);
    // The given item is kept as it was, not the filter's copy.
    expect(out[2].label).toBe('/pages');
  });

  it('runs every plugin filter in order', () => {
    const flags: AppPlugin = {
      name: 'flags',
      useNav: (items) => items.filter((i) => i.module !== 'visits'),
    };
    const reverse: AppPlugin = { name: 'reverse', useNav: (items) => [...items].reverse() };
    const out = useNavFilters(nav, [flags, { name: 'none' }, reverse]);
    expect(out.map((i) => i.href)).toEqual(['/pages', '/orders', '/']);
  });
});
