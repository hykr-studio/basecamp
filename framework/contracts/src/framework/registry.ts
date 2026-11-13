import type { Contributions } from './module.js';

/**
 * A named set of hooks or plugins of one kind (entity plugins, turn hooks, delivery channels).
 * A name is unique within its registry: registering it twice throws instead of replacing the
 * first one. `all()` keeps registration order, and hooks run in that order.
 */
export interface HookRegistry<T> {
  /** What it holds, for messages: 'turn hook'. */
  readonly kind: string;
  register(...items: T[]): void;
  get(name: string): T | undefined;
  has(name: string): boolean;
  all(): readonly T[];
}

/** The contribution keys whose lists hold items of type T. */
export type ContributionKeyOf<T> = {
  [K in keyof Contributions]-?: Contributions[K] extends readonly T[] | undefined ? K : never;
}[keyof Contributions];

/** Each contribution key's registry, set when the registry is created. */
const collectors = new Map<string, HookRegistry<unknown>>();

/**
 * A registry. With `collects`, it also takes that key's contributions when the process starts
 * (`installContributions`). It is process-global: read it when a request runs, not when a
 * module loads, because contributions are installed after the application's modules load.
 */
export function createHookRegistry<T>(
  kind: string,
  nameOf: (item: T) => string,
  options: { collects?: ContributionKeyOf<T> } = {},
): HookRegistry<T> {
  const items = new Map<string, T>();
  let list: readonly T[] = [];
  const registry: HookRegistry<T> = {
    kind,
    register(...added) {
      for (const item of added) {
        const name = nameOf(item);
        if (!name) throw new Error(`A ${kind} needs a name`);
        if (items.has(name)) throw new Error(`The ${kind} "${name}" is registered twice`);
        items.set(name, item);
      }
      list = Object.freeze([...items.values()]);
    },
    get: (name) => items.get(name),
    has: (name) => items.has(name),
    all: () => list,
  };
  const key = options.collects as string | undefined;
  if (key) {
    const taken = collectors.get(key);
    if (taken) throw new Error(`Contributions "${key}" are already collected by ${taken.kind}`);
    collectors.set(key, registry as HookRegistry<unknown>);
  }
  return registry;
}

/**
 * Put each list of contributions into the registry that collects it. A key that no registry
 * collects throws before anything is registered: a misspelt key, or a feature that is not
 * loaded, must not be ignored.
 */
export function installContributions(contributions: Partial<Contributions>): void {
  const entries = Object.entries(contributions).filter(([, items]) => items !== undefined);
  for (const [key, items] of entries) {
    if (!collectors.has(key))
      throw new Error(`Nothing collects the contribution "${key}". Is its feature loaded?`);
    if (!Array.isArray(items)) throw new Error(`Contribution "${key}" must be a list`);
  }
  for (const [key, items] of entries) collectors.get(key)?.register(...(items as unknown[]));
}
