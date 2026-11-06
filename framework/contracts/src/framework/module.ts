import type { z } from 'zod';
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

// The module id stamp: `moduleSpec` sets it on every spec of the module, once. Declared here, not
// in spec.ts, so the module system owns it. Readers: A1 (scopes), A4 (grants), A11 (flags), audit.
declare module './spec.js' {
  interface EntitySpec<
    R extends z.ZodObject = z.ZodObject,
    C extends z.ZodObject = z.ZodObject,
    U extends z.ZodObject = z.ZodObject,
  > {
    /** The module that declares it ('todos'), or 'platform' for the framework's own. */
    readonly module?: string;
  }
  interface CommandSpec<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
    /** The module that declares it ('meetings'), or 'platform' for the framework's own. */
    readonly module?: string;
  }
}

/** The module id of the framework's own specs (saved pages, send-template, request-human). */
export const PLATFORM_MODULE = 'platform';

/** A module name: lower case letters, digits and underscores, starting with a letter. */
export const MODULE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Modules that do not fit together: two declare the same name, route, tool, view or table.
 * Thrown once, with every problem found, by the merge that found them (createCatalog,
 * createUiRegistry, createNotificationCatalog, defineServer).
 */
export class ModulesError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Modules do not fit together:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ModulesError';
  }
}

/** Throws a ModulesError when there is any problem. */
export function assertNoProblems(problems: readonly string[]) {
  if (problems.length) throw new ModulesError(problems);
}

/** Set a spec's module id, once: a spec claimed by a second module is a mistake. */
export function stampModule(spec: EntitySpec | CommandSpec, module: string) {
  if (spec.module === module) return;
  if (spec.module !== undefined)
    throw new ModulesError([
      `${spec.name} belongs to the module ${spec.module}; ${module} cannot declare it too`,
    ]);
  Object.defineProperty(spec, 'module', { value: module, enumerable: true });
}

/**
 * The isomorphic half of a module, as its `contracts/index.ts` declares it: checks the name and
 * that entities are keyed by plural, and stamps every spec with the module's id. The server half
 * (`defineModule` in @hykr/api) adds the Nest module, views, notifications and agent.
 */
export function moduleSpec<
  const E extends Record<string, EntitySpec>,
  const C extends readonly CommandSpec[],
>(spec: ModuleSpec<E, C>): ModuleSpec<E, C> {
  const problems: string[] = [];
  if (!MODULE_NAME.test(spec.name))
    problems.push(
      `Module name "${spec.name}" must be lower case letters, digits and _ (it prefixes tables)`,
    );
  if (spec.name === PLATFORM_MODULE)
    problems.push(`"${PLATFORM_MODULE}" is the framework's own module name`);
  for (const [plural, entity] of Object.entries(spec.entities))
    if (entity.plural !== plural)
      problems.push(
        `${spec.name}: entity "${plural}" must be keyed by its plural (${entity.plural})`,
      );
  if ((spec.dependsOn ?? []).includes(spec.name))
    problems.push(`${spec.name} cannot depend on itself`);
  assertNoProblems(problems);
  for (const entity of Object.values(spec.entities)) stampModule(entity, spec.name);
  for (const command of spec.commands) stampModule(command, spec.name);
  return spec;
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
