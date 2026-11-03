import type { Domain } from './framework/domain.js';
import type { CommandSpec, EntitySpec } from './framework/spec.js';
import { platformCommands, platformEntities } from './platform/index.js';

/**
 * Every entity and command the system serves: the application's domain plus the framework's
 * own. Derived lists (API history, agent tools, the app's data hooks) read from a catalog;
 * the framework never imports a domain, the application passes one in.
 */
export interface Catalog<E extends Record<string, EntitySpec> = Record<string, EntitySpec>> {
  /** What the product calls itself in the UI: "Meetings". */
  name: string;
  entities: E & typeof platformEntities;
  commands: readonly CommandSpec[];
  /** Entity names as audited ('todo', 'page'): the resource types history can show. */
  entityNames: [string, ...string[]];
  entityByName(name: string): EntitySpec | undefined;
  commandByName(name: string): CommandSpec | undefined;
}

export function createCatalog<E extends Record<string, EntitySpec>>(
  domain: Domain<E, readonly CommandSpec[]>,
): Catalog<E> {
  const entities = { ...domain.entities, ...platformEntities };
  const commands: readonly CommandSpec[] = [...domain.commands, ...platformCommands];
  const all = Object.values(entities) as EntitySpec[];
  const names = new Set<string>();
  for (const spec of all) {
    if (names.has(spec.name)) throw new Error(`Entity ${spec.name} is defined twice`);
    names.add(spec.name);
  }
  return {
    name: domain.name,
    entities,
    commands,
    entityNames: all.map((s) => s.name) as [string, ...string[]],
    entityByName: (name) => all.find((s) => s.name === name),
    commandByName: (name) => commands.find((c) => c.name === name),
  };
}
