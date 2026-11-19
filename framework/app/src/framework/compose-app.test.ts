// Composing the app from its settings, modules and plugins, with fixture modules declared
// here: merge order, the module stamp, every collision, routes and links. No React Native.
import { createCatalog, defineDomain, entitySpec } from '@hykr/contracts';
import { createUiRegistry, defineScreen, defineView } from '@hykr/ui-registry';
import { bindView, getView } from '@hykr/ui-registry/react';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AppModule, type AppPlugin, defineAppModule, type NavItem } from './app-domain';
import { bindAll, composeApp, matchRoute, orderModules } from './compose-app';

const Row = z.object({ id: z.string(), title: z.string() });
const spec = (name: string) =>
  entitySpec({
    name,
    label: name,
    description: `Test ${name}s.`,
    schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
    list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 20, max: 100 } },
  });
const catalog = createCatalog(
  defineDomain({
    name: 'Fixture',
    entities: { orders: spec('order'), visits: spec('visit') },
    commands: [],
  }),
);

const dest = (href: string, label = href): NavItem => ({
  href,
  label,
  icon: 'calendar',
  match: (p) => p.startsWith(href),
});
const screen = () => null;
const app = {
  title: 'Fixture',
  tagline: 'Two modules',
  nav: [dest('/', 'Today')],
  suggestions: [{ text: 'today', what: 'the day' }],
};
const orders = defineAppModule({
  name: 'orders',
  nav: [dest('/orders', 'Orders')],
  suggestions: [{ text: 'new order', what: 'starts one' }],
  hrefFor: { order: (id) => `/orders/${id}` },
  webmcp: { orders: { reads: ['orders'] } },
});
const visits = defineAppModule({
  name: 'visits',
  nav: [dest('/visits', 'Visits')],
  suggestions: [{ text: 'plan a visit', what: 'books one' }],
  hrefFor: { visit: () => '/visits' },
  webmcp: { visit: { reads: ['visits', 'orders'] } },
});
const compose = (modules: readonly AppModule[], plugins: readonly AppPlugin[] = []) =>
  composeApp({ app, modules, plugins, catalog });

describe('defineAppModule', () => {
  it('refuses a name that is not lower case', () => {
    expect(() => defineAppModule({ name: 'Orders' })).toThrow('lower case');
  });
  it('refuses a destination outside its own prefix', () => {
    expect(() => defineAppModule({ name: 'orders', nav: [dest('/invoices')] })).toThrow(
      'the destination /invoices is not under /orders',
    );
  });
});

describe('composeApp', () => {
  it('merges in order: the app, the modules, the plugins, the framework', () => {
    const plugin: AppPlugin = { name: 'agents', nav: [dest('/agents')] };
    const c = compose([orders, visits], [plugin]);
    expect(c.nav.map((n) => n.href)).toEqual(['/', '/orders', '/visits', '/agents', '/pages']);
    expect(c.suggestions.map((s) => s.text)).toEqual(['today', 'new order', 'plan a visit']);
    expect(c.title).toBe('Fixture');
  });

  it('stamps each module destination and suggestion with its module', () => {
    const c = compose([orders, visits]);
    expect(c.nav.map((n) => n.module)).toEqual([undefined, 'orders', 'visits', undefined]);
    expect(c.suggestions.map((s) => s.module)).toEqual([undefined, 'orders', 'visits']);
  });

  it('orders modules by `order`, then by list position', () => {
    const first = defineAppModule({ ...visits, order: -1 });
    expect(compose([orders, first]).modules.map((m) => m.name)).toEqual(['visits', 'orders']);
    expect(compose([visits, orders]).modules.map((m) => m.name)).toEqual(['visits', 'orders']);
  });

  it('sorts a namespace object by key before `order`, and refuses what is not a module', () => {
    expect(orderModules({ visits, orders }).map((m) => m.name)).toEqual(['orders', 'visits']);
    const TodoRow = () => null;
    expect(() =>
      composeApp({
        app,
        modules: { orders, TodoRow } as unknown as Record<string, AppModule>,
        catalog,
      }),
    ).toThrow('App module TodoRow is not an app module: create it with defineAppModule');
  });

  it('refuses two modules with one name', () => {
    const again = defineAppModule({ name: 'orders' });
    expect(() => compose([orders, again])).toThrow('Two app modules are called "orders"');
  });

  it('refuses a module named after a framework route', () => {
    expect(() => compose([defineAppModule({ name: 'pages' })])).toThrow("the framework's own");
  });

  it('refuses one destination claimed twice', () => {
    const appOwned = { ...app, nav: [dest('/orders')] };
    expect(() => composeApp({ app: appOwned, modules: [orders], catalog })).toThrow(
      'The destination /orders is claimed twice (by the app and by module orders)',
    );
    const plugin: AppPlugin = { name: 'p', nav: [dest('/pages')] };
    expect(() => compose([], [plugin])).toThrow('(by plugin p and by the framework)');
  });

  it("refuses a plugin destination under a module's prefix", () => {
    const plugin: AppPlugin = { name: 'p', nav: [dest('/orders/report')] };
    expect(() => compose([orders], [plugin])).toThrow('belongs to module orders');
  });

  it('refuses one suggestion twice', () => {
    const dup = defineAppModule({ name: 'visits', suggestions: [{ text: 'today', what: 'x' }] });
    expect(() => compose([dup])).toThrow('The suggestion “today” is claimed twice');
  });

  it('links each record type through its module, and the framework links saved pages', () => {
    const c = compose([orders, visits]);
    expect(c.hrefFor('order', 'o1')).toBe('/orders/o1');
    expect(c.hrefFor('visit', 'v1')).toBe('/visits');
    expect(c.hrefFor('page', 'p1')).toBe('/pages/p1');
    expect(c.hrefFor('invoice', 'i1')).toBeUndefined();
  });

  it('refuses a record type claimed twice, or one the catalog does not have', () => {
    const dup = defineAppModule({ name: 'visits', hrefFor: { order: () => '/visits' } });
    expect(() => compose([orders, dup])).toThrow(
      'The record type order is claimed twice (by module orders and by module visits)',
    );
    const page = defineAppModule({ name: 'visits', hrefFor: { page: () => '/visits' } });
    expect(() => compose([page])).toThrow('(by the framework and by module visits)');
    const typo = defineAppModule({ name: 'visits', hrefFor: { vist: () => '/visits' } });
    expect(() => compose([typo])).toThrow('hrefFor names "vist", which is no entity');
  });

  it('answers WebMCP per screen, with the module that declared it', () => {
    const c = compose([orders, visits]);
    expect(c.webMcpFor('orders')).toEqual({ reads: ['orders'], module: 'orders' });
    expect(c.webMcpFor('visit')?.reads).toEqual(['visits', 'orders']);
    expect(c.webMcpFor('today')).toBeUndefined();
  });

  it('refuses a WebMCP screen claimed twice, or one that reads an unknown entity', () => {
    const dup = defineAppModule({ name: 'visits', webmcp: { orders: { reads: ['visits'] } } });
    expect(() => compose([orders, dup])).toThrow('The WebMCP screen orders is claimed twice');
    const unknown = defineAppModule({
      name: 'visits',
      webmcp: { visits: { reads: ['invoices'] } },
    });
    expect(() => compose([unknown])).toThrow('reads "invoices", which is no entity');
  });

  it('refuses a WebMCP screen that reads an entity whose list and get are closed to agents', () => {
    const peopleOnly = createCatalog(
      defineDomain({
        name: 'Fixture',
        entities: {
          orders: spec('order'),
          visits: {
            ...spec('visit'),
            expose: { list: 'human', get: 'internal', create: 'all', update: 'all', delete: 'all' },
          },
        },
        commands: [],
      }),
    );
    const reader = defineAppModule({ name: 'visits', webmcp: { visits: { reads: ['visits'] } } });
    expect(() => composeApp({ app, modules: [reader], catalog: peopleOnly })).toThrow(
      'WebMCP screen visits reads "visits", whose list and get are not open to agents',
    );
  });

  it('collects plugins from the shell, then from modules, and refuses a name twice', () => {
    const mine = defineAppModule({ name: 'visits', plugins: [{ name: 'calendar' }] });
    expect(compose([mine], [{ name: 'push' }]).plugins.map((p) => p.name)).toEqual([
      'push',
      'calendar',
    ]);
    expect(() => compose([mine], [{ name: 'calendar' }])).toThrow(
      'The app plugin calendar is claimed twice (by the app and by module visits)',
    );
  });

  it('checks plugin routes: well formed, unique in shape, not under a module or the framework', () => {
    const route = (path: string): AppPlugin => ({ name: path, routes: [{ path, screen }] });
    expect(compose([], [route('/approvals/:id')]).routes[0]).toMatchObject({
      path: '/approvals/:id',
      plugin: '/approvals/:id',
    });
    expect(() => compose([], [route('approvals')])).toThrow('a path starts with /');
    expect(() => compose([], [route('/a//b')])).toThrow('no empty segment');
    expect(() => compose([], [route('/:token')])).toThrow('the first segment must be fixed');
    expect(() => compose([], [route('/s/:a/:a')])).toThrow('a param appears twice');
    expect(() => compose([orders], [route('/orders/:id')])).toThrow('belongs to module orders');
    expect(() => compose([], [route('/pages/x')])).toThrow('belongs to the framework');
    expect(() => compose([], [route('/s/:token'), route('/s/:code')])).toThrow(
      'The route /s/: is claimed twice',
    );
  });
});

describe('matchRoute', () => {
  const routes = [
    { path: '/approvals/:id', screen },
    { path: '/approvals/inbox', screen },
    { path: '/s/:token', screen, public: true },
  ];
  it('matches fixed segments and takes params, decoded', () => {
    expect(matchRoute(routes, '/s/abc%20d')).toEqual({
      route: routes[2],
      params: { token: 'abc d' },
    });
    expect(matchRoute(routes, '/approvals/a1/')?.params).toEqual({ id: 'a1' });
    expect(matchRoute(routes, '/approvals/a1?x=1')?.params).toEqual({ id: 'a1' });
  });
  it('prefers the route with more fixed segments', () => {
    expect(matchRoute(routes, '/approvals/inbox')?.route).toBe(routes[1]);
  });
  it('matches nothing of another length or another prefix, nor a malformed segment', () => {
    expect(matchRoute(routes, '/approvals')).toBeUndefined();
    expect(matchRoute(routes, '/approvals/a/b')).toBeUndefined();
    expect(matchRoute(routes, '/orders/a')).toBeUndefined();
    expect(matchRoute(routes, '/s/%E0%A4%A')).toBeUndefined();
  });
});

describe('bindAll', () => {
  const Card = defineView({
    name: 'order.card',
    description: 'An order.',
    surfaces: ['inline'],
    props: z.object({ title: z.string() }),
    text: (p) => p.title,
    speak: (p) => p.title,
  });
  const Stray = defineView({
    name: 'order.stray',
    description: 'Not registered.',
    surfaces: ['inline'],
    props: z.object({ title: z.string() }),
    text: (p) => p.title,
    speak: (p) => p.title,
  });
  const Detail = defineScreen({
    name: 'order.detail',
    title: 'Order',
    description: 'An order.',
    params: z.object({ id: z.string() }),
  });
  const registry = createUiRegistry({ views: [Card], screens: [Detail] });
  const One = () => null;
  afterEach(() => bindAll([], registry));

  it('binds each owner, from a clean slate', () => {
    bindAll([{ owner: 'orders', bind: () => bindView(Card, One) }], registry);
    expect(getView('order.card')).toBe(One);
    // Again (Fast Refresh): the earlier binding is gone, so this is no duplicate.
    expect(() =>
      bindAll([{ owner: 'orders', bind: () => bindView(Card, One) }], registry),
    ).not.toThrow();
  });

  it('refuses a view two modules bind, naming both', () => {
    expect(() =>
      bindAll(
        [
          { owner: 'orders', bind: () => bindView(Card, One) },
          { owner: 'visits', bind: () => bindView(Card, One) },
        ],
        registry,
      ),
    ).toThrow('The view "order.card" is bound twice (by orders and by visits)');
  });

  it('refuses a bound view the registry does not have', () => {
    expect(() =>
      bindAll([{ owner: 'orders', bind: () => bindView(Stray, One) }], registry),
    ).toThrow(
      'Bound but not in the registry (add them to the views the app registers): view order.stray',
    );
  });
});
