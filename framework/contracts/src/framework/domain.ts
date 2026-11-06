import type { CommandSpec, EntitySpec } from './spec.js';

/**
 * A set of entities (keyed by plural, the name used in routes and query keys) and commands under
 * one name: what `createCatalog` takes per part. An application declares its parts as modules
 * (`moduleSpec`, module.ts), which also stamp each spec with the module's id; `defineDomain` is
 * for one-off sets, such as a test's.
 */
export interface Domain<
  E extends Record<string, EntitySpec> = Record<string, EntitySpec>,
  C extends readonly CommandSpec[] = readonly CommandSpec[],
> {
  /** What the product calls itself in the UI: "Meetings". */
  name: string;
  entities: E;
  commands: C;
}

export function defineDomain<
  E extends Record<string, EntitySpec>,
  C extends readonly CommandSpec[],
>(domain: Domain<E, C>): Domain<E, C> {
  for (const [plural, spec] of Object.entries(domain.entities)) {
    if (spec.plural !== plural)
      throw new Error(`Domain entity "${plural}" must be keyed by its plural (${spec.plural})`);
  }
  return domain;
}
