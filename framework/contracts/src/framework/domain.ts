import type { CommandSpec, EntitySpec } from './spec.js';

/**
 * A business domain, as the framework sees it: its entities (keyed by plural, the name used
 * in routes and query keys) and its commands. Everything else (API routes, agent tools,
 * views, the app's data hooks) is derived from this one declaration, so replacing the
 * domain means replacing the folders that declare it, nothing in the framework.
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
