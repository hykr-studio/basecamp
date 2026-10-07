import { domain } from './domain/index.js';
import type { CommandSpec, EntitySpec } from './framework/spec.js';
import { platformEntities } from './platform/index.js';

/**
 * Every entity and command the system serves: the domain's plus the framework's own.
 * Derived lists (API history, agent tools, the app's data hooks) read from here.
 */
export const entities = { ...domain.entities, ...platformEntities };
export type EntityKey = keyof typeof entities;
export const commands: readonly CommandSpec[] = domain.commands;

const all = Object.values(entities) as EntitySpec[];
/** Entity names as audited ('todo', 'page'): the resource types history can show. */
export const entityNames = all.map((s) => s.name) as [string, ...string[]];
export const entityByName = (name: string): EntitySpec | undefined =>
  all.find((s) => s.name === name);
export const commandByName = (name: string): CommandSpec | undefined =>
  commands.find((c) => c.name === name);
