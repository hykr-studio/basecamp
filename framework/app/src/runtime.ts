import type { Catalog } from '@hykr/contracts';
import type { Registry } from '@hykr/ui-registry';
import type { ComposedApp } from './framework/compose-app';

/**
 * What the application gives the framework: its catalog (entities and commands), its
 * registry (views and screens) and its app, composed from its settings, modules and plugins.
 * Set once by AppShell, before anything renders; the framework never imports the application.
 */
export interface AppRuntime {
  catalog: Catalog;
  registry: Registry;
  app: ComposedApp;
}

let current: AppRuntime | undefined;

/** AppShell calls this before rendering. Call it yourself only to use the framework without it. */
export function setRuntime(runtime: AppRuntime) {
  current = runtime;
}

/** The application's catalog, registry and composed app, for code outside React too. */
export function getRuntime(): AppRuntime {
  if (!current)
    throw new Error('@hykr/app: render <AppShell> (or call setRuntime) before using the framework');
  return current;
}

export const getCatalog = () => getRuntime().catalog;
export const getRegistry = () => getRuntime().registry;
/** The app as composed from the application's settings, modules and plugins. */
export const getApp = () => getRuntime().app;

/**
 * Where a record opens in this app, from the modules' `hrefFor` (and the framework's, for saved
 * pages); undefined when no module shows that type. `type` is the entity's audited name.
 */
export const hrefFor = (type: string, id: string) => getApp().hrefFor(type, id);

/** The WebMCP read tools declared for a screen (its `useScreenContext` name), with its module. */
export const webMcpFor = (screen: string) => getApp().webMcpFor(screen);
