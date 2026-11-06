import type { ComponentType, ReactNode } from 'react';
import type { SessionUser } from '../session';
import type { EntityName } from './hooks';
import type { IconName } from './Icon';

/** A top-level destination: the rail on wide screens, the tab bar on phones. */
export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  match: (path: string) => boolean;
  /** The app module it belongs to. Set when the shell merges the modules; none for the app's own. */
  readonly module?: string;
};

/** A message the assistant understands, offered in the thread ("What can it do?"). */
export type Suggestion = {
  text: string;
  what: string;
  /** The app module it comes from, set by the merge. */
  readonly module?: string;
};

/**
 * What a browser agent may call while a screen is open (WebMCP). Declarative: the WebMCP
 * feature turns it into tools behind feature detection; the API applies the person's access to
 * every call. Open: a feature adds its keys by declaration merging.
 */
export interface WebMcpScreen {
  /** Entities, by plural, whose read tools (list, get) the screen offers. */
  reads: readonly EntityName[];
}

/** WebMCP declarations, keyed by the screen's `useScreenContext({ screen })` name. */
export type WebMcpScreens = Readonly<Record<string, WebMcpScreen>>;

/**
 * A screen at a path no route file claims, from a framework feature: `/approvals/:id`. The
 * application's `+not-found` route serves it (`NotFoundScreen`), since Expo Router only knows
 * route files.
 */
export interface AppRoute {
  /** Fixed segments and `:params`: '/approvals/:id'. */
  path: string;
  screen: ComponentType<{ params: Readonly<Record<string, string>> }>;
  /**
   * Also shown when nobody is signed in, on its own, without the navigation or the thread.
   * The API still decides what it may load. Off by default: a route needs a session.
   */
  public?: boolean;
}

/**
 * How a framework feature plugs into the shell (push, offline, WebMCP, feature flags, share
 * links). Every slot is optional. The application lists plugins in `<AppShell plugins>`, and a
 * module may bring its own (`AppModule.plugins`).
 */
export interface AppPlugin {
  /** Unique among the app's plugins: 'push'. */
  name: string;
  /**
   * Wraps the app under the shell's own providers (data, toasts, language, assistant), signed in
   * or not. The first plugin is the outermost.
   */
  Provider?: ComponentType<{ children: ReactNode }>;
  /**
   * Runs when a person is signed in, once per person. The function it returns runs at sign-out
   * (or when another person signs in). A throw or a rejected promise is logged, never thrown
   * into the app, and the other plugins still run.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a callback may return nothing, a cleanup or a promise
  onSignedIn?: (user: SessionUser) => void | (() => void) | Promise<unknown>;
  /** Its screens, at paths no route file claims. */
  routes?: readonly AppRoute[];
  /** Destinations for its screens, after the modules' and before the framework's. */
  nav?: readonly NavItem[];
  /**
   * A hook that narrows the destinations (feature flags, roles). It runs on every render of the
   * shell, in plugin order. It may hide or reorder destinations, not add them: an item it
   * returns that it was not given is dropped. Hide a whole module through `item.module`.
   */
  useNav?: (items: readonly NavItem[]) => readonly NavItem[];
}

/**
 * The application's own part of the app: its name, and the screens that belong to no single
 * module (the home screen, which combines several). Its routes live in its own src/app.
 */
export interface AppSettings {
  /** The product's name: the rail, the phone's top bar and the sign-in screen. */
  title: string;
  /** Under the product name in the rail: what this deployment is about. */
  tagline: string;
  /** Where "not found" sends a person back to. The first destination when not set. */
  home?: { href: string; label: string };
  /** The application's own destinations (the home screen), before the modules'. */
  nav?: readonly NavItem[];
  /** Messages to offer when the thread is empty or the person asks what it can do. First. */
  suggestions?: readonly Suggestion[];
  /** WebMCP for the application's own screens. */
  webmcp?: WebMcpScreens;
}

/**
 * One application module, app side: what the shell needs from it. Its routes are files under
 * the application's src/app/<name>/ (one-line re-exports of the module's route components), its
 * view and screen components are bound by `bind`. Teams build modules in parallel; the shell
 * merges them and refuses any collision when it starts.
 */
export interface AppModule {
  /** Lower case, unique in the app, the same as its server module: 'meetings'. Its URLs are /<name>/…. */
  name: string;
  /** Where its destinations go among the modules': lower first. Default 0; ties keep list order. */
  order?: number;
  /** Its destinations, each under /<name>. */
  nav?: readonly NavItem[];
  /** Messages the assistant understands about this module, after the application's own. */
  suggestions?: readonly Suggestion[];
  /** Bind its components to its views and screens (`bindView` / `bindScreen`), once at startup. */
  bind?: () => void;
  /**
   * Where one of its records opens, by record type (the entity's audited name), so the
   * assistant's activity and other modules can link to it: `{ meeting: (id) => '/meetings/' + id }`.
   */
  hrefFor?: Readonly<Record<string, (id: string) => string>>;
  /** WebMCP for its screens, keyed by the screen's `useScreenContext({ screen })` name. */
  webmcp?: WebMcpScreens;
  /** Framework plugins it needs. */
  plugins?: readonly AppPlugin[];
}

const NAME = /^[a-z][a-z0-9-]*$/;
const defined = new WeakSet<object>();

/** Did this object come from `defineAppModule`? The shell refuses anything else. */
export const isAppModule = (value: unknown): value is AppModule =>
  typeof value === 'object' && value !== null && defined.has(value);

/** Is `href` under the module's own prefix (/name, /name/…, /name?…)? */
export const underPrefix = (name: string, href: string) =>
  href === `/${name}` || href.startsWith(`/${name}/`) || href.startsWith(`/${name}?`);

/**
 * Declare an app module. Checks what it can on its own (the name, that its destinations are
 * under /<name>); collisions with other modules are checked when the shell merges them.
 */
export function defineAppModule(module: AppModule): AppModule {
  if (!NAME.test(module.name))
    throw new Error(
      `App module "${module.name}": a name is lower case letters, digits and dashes ('orders')`,
    );
  for (const item of module.nav ?? [])
    if (!underPrefix(module.name, item.href))
      throw new Error(
        `App module "${module.name}": the destination ${item.href} is not under /${module.name}`,
      );
  defined.add(module);
  return module;
}
