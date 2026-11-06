import type { CommandSpec, EntitySpec } from './spec.js';

/**
 * What a module or a framework feature adds to the running system, one list per kind: entity
 * plugins, write hooks, turn hooks, delivery channels, queues and so on. Open: the package that
 * owns a kind declares its key by declaration merging, next to the registry that collects it:
 *
 *   declare module '@hykr/contracts' {
 *     interface Contributions { turnHooks: readonly TurnHook[] }
 *   }
 *
 * Inputs are always `Partial<Contributions>`; `installContributions` (registry.ts) puts each
 * list into its registry when the process starts.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface Contributions {}

/** The isomorphic half of an application module: its specs, read by the server and the apps. */
export interface ModuleSpec<
  E extends Record<string, EntitySpec> = Record<string, EntitySpec>,
  C extends readonly CommandSpec[] = readonly CommandSpec[],
> {
  /** Lower case, unique in the application: 'orders'. Prefixes its tables, queues and scopes. */
  name: string;
  /** The modules it builds on, by name. It reaches them only through their public entry points. */
  dependsOn?: readonly string[];
  /** Keyed by plural, as in `defineDomain`. */
  entities: E;
  commands: C;
}

/** Several sets of contributions as one, each kind's lists concatenated in order. */
export function mergeContributions(
  ...parts: (Partial<Contributions> | undefined)[]
): Partial<Contributions> {
  const out: Record<string, unknown[]> = {};
  for (const part of parts) {
    for (const [key, items] of Object.entries(part ?? {})) {
      if (items === undefined) continue;
      if (!Array.isArray(items)) throw new Error(`Contribution "${key}" must be a list`);
      out[key] = [...(out[key] ?? []), ...items];
    }
  }
  return out as Partial<Contributions>;
}
