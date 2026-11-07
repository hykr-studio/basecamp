// Feature flags (A11): switches an application declares, each business has on or off. Off is
// the default and wins on any doubt (fail closed). What a flag gates is declared with it, so
// the server, the assistant's tools and the apps all hide the same things.
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import { createHookRegistry } from '../framework/registry.js';

declare module '../framework/module.js' {
  interface Contributions {
    featureFlags: readonly FeatureFlagDef[];
  }
}

/** A flag's key: dotted lower case words, prefixed by its owner ('todos.clear-done'). */
export const FEATURE_KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** What a flag switches off for a business that does not have it on. */
export interface FeatureGates {
  /** Whole modules, by name: their entities, commands, tools and destinations. */
  modules?: readonly string[];
  /** Entities, by name ('todo'): their routes and tools. */
  entities?: readonly string[];
  /** Commands, by name ('todo.clearDone'): their routes and tools. */
  commands?: readonly string[];
  /** Any tool id, generated or contributed ('clear-done-todos'). */
  tools?: readonly string[];
  /** App destinations, by href ('/todos/board'). */
  nav?: readonly string[];
}

/**
 * Who may switch a flag. `platform` (the default): only the platform, from server code, so a
 * business cannot turn on what it was not given. `tenant`: the business itself, by someone
 * with `settings.manage`.
 */
export type FeatureManager = 'platform' | 'tenant';

/** One flag, as the application declares it. */
export interface FeatureFlagDef {
  key: string;
  label: Labels;
  description?: Labels;
  managedBy?: FeatureManager;
  gates?: FeatureGates;
}

/** Every declared flag, by key. Collects `contributes.featureFlags`. */
export const featureFlags = createHookRegistry<FeatureFlagDef>(
  'feature flag',
  (f) => defineFeatureFlag(f).key,
  { collects: 'featureFlags' },
);

/** A flag, checked: its key and the names it gates. Register it by contributing it. */
export function defineFeatureFlag(def: FeatureFlagDef): FeatureFlagDef {
  if (!FEATURE_KEY.test(def.key))
    throw new Error(`Feature flag "${def.key}": use dotted lower case words ('orders.export')`);
  for (const href of def.gates?.nav ?? [])
    if (!href.startsWith('/')) throw new Error(`Feature flag "${def.key}": "${href}" is no href`);
  return def;
}

/** What a flag may name: everything the application has, by kind. */
export interface FlagTargets {
  modules: Iterable<string>;
  entities: Iterable<string>;
  commands: Iterable<string>;
  tools: Iterable<string>;
}

/**
 * A flag that names a module, entity, command or tool the application does not have would gate
 * nothing (a typo would leave the feature on for everyone): each one is a problem, and the API
 * refuses to start.
 */
export function featureFlagProblems(
  flags: readonly FeatureFlagDef[],
  targets: FlagTargets,
): string[] {
  const problems: string[] = [];
  for (const kind of ['modules', 'entities', 'commands', 'tools'] as const) {
    const known = new Set(targets[kind]);
    for (const flag of flags)
      for (const name of flag.gates?.[kind] ?? [])
        if (!known.has(name))
          problems.push(`The feature flag ${flag.key} gates ${kind} "${name}", which is not there`);
  }
  return problems;
}

/** Everything that is off for one business: what its switched-off flags gate, merged. */
export const GatedOff = z.object({
  modules: z.array(z.string()),
  entities: z.array(z.string()),
  commands: z.array(z.string()),
  tools: z.array(z.string()),
  nav: z.array(z.string()),
});
export type GatedOff = z.infer<typeof GatedOff>;

/**
 * What these flags switch off when only the keys `isOn` says are on. Something several flags
 * gate is off when any of them is off.
 */
export function gatedOff(
  flags: readonly FeatureFlagDef[],
  isOn: (key: string) => boolean,
): GatedOff {
  const off = {
    modules: new Set<string>(),
    entities: new Set<string>(),
    commands: new Set<string>(),
    tools: new Set<string>(),
    nav: new Set<string>(),
  };
  for (const flag of flags) {
    if (isOn(flag.key)) continue;
    for (const kind of ['modules', 'entities', 'commands', 'tools', 'nav'] as const)
      for (const name of flag.gates?.[kind] ?? []) off[kind].add(name);
  }
  return {
    modules: [...off.modules],
    entities: [...off.entities],
    commands: [...off.commands],
    tools: [...off.tools],
    nav: [...off.nav],
  };
}

/** One flag as a business sees it (GET /api/features). */
export const FeatureState = z.object({
  key: z.string(),
  label: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()).nullable(),
  managedBy: z.enum(['platform', 'tenant']),
  on: z.boolean(),
  gates: z.object({
    modules: z.array(z.string()),
    entities: z.array(z.string()),
    commands: z.array(z.string()),
    tools: z.array(z.string()),
    nav: z.array(z.string()),
  }),
});
export type FeatureState = z.infer<typeof FeatureState>;
