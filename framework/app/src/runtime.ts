import type { Catalog } from '@hykr/contracts';
import type { Registry } from '@hykr/ui-registry';
import type { AppDomain } from './framework/app-domain';

/**
 * What the application gives the framework: its catalog (entities and commands), its
 * registry (views and screens) and its shell settings. Set once by AppShell, before anything
 * renders; the framework never imports the application.
 */
export interface AppRuntime {
  catalog: Catalog;
  registry: Registry;
  appDomain: AppDomain;
}

let current: AppRuntime | undefined;

/** AppShell calls this before rendering. Call it yourself only to use the framework without it. */
export function setRuntime(runtime: AppRuntime) {
  current = runtime;
}

/** The application's catalog, registry and shell settings, for code outside React too. */
export function getRuntime(): AppRuntime {
  if (!current)
    throw new Error('@hykr/app: render <AppShell> (or call setRuntime) before using the framework');
  return current;
}

export const getCatalog = () => getRuntime().catalog;
export const getRegistry = () => getRuntime().registry;
export const getAppDomain = () => getRuntime().appDomain;
