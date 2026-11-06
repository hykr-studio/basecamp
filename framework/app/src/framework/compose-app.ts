import type { Catalog } from '@hykr/contracts';
import type { Registry } from '@hykr/ui-registry';
import { bindingAs, boundScreens, boundViews, clearBindings } from '@hykr/ui-registry/react';
import {
  type AppModule,
  type AppPlugin,
  type AppRoute,
  type AppSettings,
  isAppModule,
  type NavItem,
  type Suggestion,
  underPrefix,
  type WebMcpScreen,
} from './app-domain';

/** The framework's own destinations, after everything else. */
export const FRAMEWORK_NAV: readonly NavItem[] = [
  { href: '/pages', label: 'Pages', icon: 'layout', match: (p) => p.startsWith('/pages') },
];

/** Records the framework links itself: saved pages. */
const FRAMEWORK_HREFS: Readonly<Record<string, (id: string) => string>> = {
  page: (id) => `/pages/${id}`,
};

/** First path segments the framework's own route files use: no module or plugin may take them. */
const RESERVED = new Set(['pages']);

/** A plugin's route, with the plugin it came from. */
export type ComposedRoute = AppRoute & { readonly plugin: string };

/** A WebMCP declaration, with the module that made it (none for the application's own). */
export type ComposedWebMcp = WebMcpScreen & { readonly module?: string };

/**
 * The app as the shell runs it: the application's settings and every module and plugin,
 * merged in order (the application's, the modules', the plugins', the framework's) and checked.
 */
export interface ComposedApp {
  title: string;
  tagline: string;
  home?: { href: string; label: string };
  /** In nav order (`order`, then list order). */
  modules: readonly AppModule[];
  nav: readonly NavItem[];
  suggestions: readonly Suggestion[];
  /** The shell's plugins, then each module's. */
  plugins: readonly AppPlugin[];
  routes: readonly ComposedRoute[];
  /** Where a record opens: the path its module gave, or undefined. */
  hrefFor(type: string, id: string): string | undefined;
  /** What a browser agent may read on this screen, or undefined. */
  webMcpFor(screen: string): ComposedWebMcp | undefined;
}

/** A list of modules, or the namespace of a barrel that exports one per line. */
export type ModuleList = readonly AppModule[] | Readonly<Record<string, AppModule>>;

/**
 * The modules in nav order: by `order` (default 0), then by position. A namespace object is first
 * sorted by key, since bundlers disagree on a namespace's key order. Anything not made with
 * `defineAppModule` throws.
 */
export function orderModules(modules: ModuleList): AppModule[] {
  const entries: [string, unknown][] = Array.isArray(modules)
    ? (modules as readonly unknown[]).map((m, i) => [`#${i}`, m])
    : Object.keys(modules)
        .sort()
        .map((key) => [key, (modules as Record<string, unknown>)[key]]);
  for (const [key, m] of entries)
    if (!isAppModule(m))
      throw new Error(`App module ${key} is not an app module: create it with defineAppModule`);
  return (entries as [string, AppModule][])
    .map(([, m], i) => ({ m, i }))
    .sort((a, b) => (a.m.order ?? 0) - (b.m.order ?? 0) || a.i - b.i)
    .map(({ m }) => m);
}

/** Remember who claimed `key`; a second claim throws, naming both. */
function claimer(what: string) {
  const seen = new Map<string, string>();
  return (key: string, by: string) => {
    const first = seen.get(key);
    if (first !== undefined)
      throw new Error(`${what} ${key} is claimed twice (by ${first} and by ${by})`);
    seen.set(key, by);
  };
}

const segments = (path: string) =>
  path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((s) => s !== '');

const PARAM = /^:[A-Za-z_]\w*$/;

/** A route's path, checked: fixed first segment, no empty segments, distinct params. */
function checkRoute(route: AppRoute, plugin: string, modules: ReadonlySet<string>) {
  const where = `Plugin "${plugin}" route ${route.path}`;
  if (!route.path.startsWith('/') || /[?#]/.test(route.path) || route.path.includes('//'))
    throw new Error(`${where}: a path starts with / and has no empty segment, query or hash`);
  const parts = segments(route.path);
  if (parts.length === 0 || parts[0].startsWith(':'))
    throw new Error(`${where}: the first segment must be fixed, or it would catch every path`);
  if (modules.has(parts[0]) || RESERVED.has(parts[0]))
    throw new Error(
      `${where}: /${parts[0]} belongs to ${RESERVED.has(parts[0]) ? 'the framework' : `module ${parts[0]}`}`,
    );
  const params = parts.filter((p) => p.startsWith(':'));
  for (const p of params) if (!PARAM.test(p)) throw new Error(`${where}: ${p} is not a param name`);
  if (new Set(params).size !== params.length) throw new Error(`${where}: a param appears twice`);
  // Two routes with the same shape would match the same paths.
  return `/${parts.map((p) => (p.startsWith(':') ? ':' : p)).join('/')}`;
}

/**
 * Merge the application's settings, its modules and its plugins into the app the shell runs,
 * refusing every collision: two modules with one name, two destinations with one href, one
 * suggestion twice, a record type or a WebMCP screen claimed twice, two plugins with one name,
 * two routes with one shape. Each module's and plugin's own declarations are checked too.
 */
export function composeApp(input: {
  app: AppSettings;
  modules: ModuleList;
  plugins?: readonly AppPlugin[];
  catalog: Catalog;
}): ComposedApp {
  const { app, catalog } = input;
  const modules = orderModules(input.modules);
  const moduleNames = new Set<string>();
  for (const m of modules) {
    if (moduleNames.has(m.name)) throw new Error(`Two app modules are called "${m.name}"`);
    if (RESERVED.has(m.name))
      throw new Error(`App module "${m.name}": /${m.name} is the framework's own route`);
    moduleNames.add(m.name);
  }

  // Plugins: the shell's, then each module's.
  const plugins: AppPlugin[] = [];
  const claimPlugin = claimer('The app plugin');
  for (const p of input.plugins ?? []) {
    claimPlugin(p.name, 'the app');
    plugins.push(p);
  }
  for (const m of modules)
    for (const p of m.plugins ?? []) {
      claimPlugin(p.name, `module ${m.name}`);
      plugins.push(p);
    }

  // Destinations: the application's, the modules', the plugins', the framework's.
  const nav: NavItem[] = [];
  const claimHref = claimer('The destination');
  for (const item of app.nav ?? []) {
    claimHref(item.href, 'the app');
    nav.push(item);
  }
  for (const m of modules)
    for (const item of m.nav ?? []) {
      // defineAppModule checked it; a module object edited since is checked again.
      if (!underPrefix(m.name, item.href))
        throw new Error(
          `App module "${m.name}": the destination ${item.href} is not under /${m.name}`,
        );
      claimHref(item.href, `module ${m.name}`);
      nav.push({ ...item, module: m.name });
    }
  for (const p of plugins)
    for (const item of p.nav ?? []) {
      const first = segments(item.href)[0];
      if (first && moduleNames.has(first))
        throw new Error(
          `Plugin "${p.name}": the destination ${item.href} belongs to module ${first}`,
        );
      claimHref(item.href, `plugin ${p.name}`);
      nav.push(item);
    }
  for (const item of FRAMEWORK_NAV) {
    claimHref(item.href, 'the framework');
    nav.push(item);
  }

  const suggestions: Suggestion[] = [];
  const claimText = claimer('The suggestion');
  for (const s of app.suggestions ?? []) {
    claimText(`“${s.text}”`, 'the app');
    suggestions.push(s);
  }
  for (const m of modules)
    for (const s of m.suggestions ?? []) {
      claimText(`“${s.text}”`, `module ${m.name}`);
      suggestions.push({ ...s, module: m.name });
    }

  // Links to records, by record type; each type has one owner, and is an entity in the catalog.
  const links = new Map<string, (id: string) => string>();
  const claimType = claimer('The record type');
  const link = (map: Readonly<Record<string, (id: string) => string>>, by: string) => {
    for (const [type, href] of Object.entries(map)) {
      if (!catalog.entityByName(type))
        throw new Error(`${by}: hrefFor names "${type}", which is no entity in the catalog`);
      claimType(type, by);
      links.set(type, href);
    }
  };
  link(FRAMEWORK_HREFS, 'the framework');
  for (const m of modules) link(m.hrefFor ?? {}, `module ${m.name}`);

  // WebMCP, by screen; each screen has one owner, and reads only entities in the catalog.
  const webmcp = new Map<string, ComposedWebMcp>();
  const claimScreen = claimer('The WebMCP screen');
  const declare = (screens: AppSettings['webmcp'], module?: string) => {
    const by = module ? `module ${module}` : 'the app';
    for (const [screen, decl] of Object.entries(screens ?? {})) {
      for (const plural of decl.reads)
        if (!Object.hasOwn(catalog.entities, plural))
          throw new Error(`${by}: WebMCP screen ${screen} reads "${plural}", which is no entity`);
      claimScreen(screen, by);
      webmcp.set(screen, module ? { ...decl, module } : { ...decl });
    }
  };
  declare(app.webmcp);
  for (const m of modules) declare(m.webmcp, m.name);

  const routes: ComposedRoute[] = [];
  const claimShape = claimer('The route');
  for (const p of plugins)
    for (const route of p.routes ?? []) {
      claimShape(checkRoute(route, p.name, moduleNames), `plugin ${p.name}`);
      routes.push({ ...route, plugin: p.name });
    }

  return {
    title: app.title,
    tagline: app.tagline,
    home: app.home,
    modules: Object.freeze(modules),
    nav: Object.freeze(nav),
    suggestions: Object.freeze(suggestions),
    plugins: Object.freeze(plugins),
    routes: Object.freeze(routes),
    hrefFor: (type, id) => links.get(type)?.(id),
    webMcpFor: (screen) => webmcp.get(screen),
  };
}

/**
 * The route for a path, with its params: fixed segments must be equal, `:params` take the
 * segment (decoded). When two match, the one with more fixed segments wins.
 */
export function matchRoute<R extends AppRoute>(
  routes: readonly R[],
  path: string,
): { route: R; params: Record<string, string> } | undefined {
  const parts = segments(path);
  let best: { route: R; params: Record<string, string>; fixed: number } | undefined;
  for (const route of routes) {
    const pattern = segments(route.path);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let fixed = 0;
    let ok = true;
    for (let i = 0; ok && i < pattern.length; i++) {
      if (pattern[i].startsWith(':')) {
        try {
          params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
        }
      } else if (pattern[i] === parts[i]) fixed++;
      else ok = false;
    }
    if (ok && (!best || fixed > best.fixed)) best = { route, params, fixed };
  }
  return best && { route: best.route, params: best.params };
}

/**
 * Bind every component, from a clean slate: each step binds as its owner ('framework', a
 * module's name), so a view or screen bound twice names both. Then every bound view and screen
 * must be in the registry: the assistant could never show one that is not.
 */
export function bindAll(
  steps: readonly { owner: string; bind?: () => void }[],
  registry: Pick<Registry, 'getViewDef' | 'getScreenDef'>,
) {
  clearBindings();
  for (const step of steps) if (step.bind) bindingAs(step.owner, step.bind);
  const views = boundViews().filter((v) => !registry.getViewDef(v));
  const screens = boundScreens().filter((s) => !registry.getScreenDef(s));
  if (views.length || screens.length)
    throw new Error(
      `Bound but not in the registry (add them to the views the app registers): ${[
        ...views.map((v) => `view ${v}`),
        ...screens.map((s) => `screen ${s}`),
      ].join(', ')}`,
    );
}
