// The boot checks that need more than one part of the application: what a spec, a view or a
// notification names must exist in the merged catalog, registry and notification catalog, and
// modules' tables must not collide. defineServer runs them after the merges' own checks
// (createCatalog, createUiRegistry, createNotificationCatalog).
import { scriptConflicts } from '@hykr/agents';
import type { Catalog, EntitySpec } from '@hykr/contracts';
import { schema as frameworkSchema } from '@hykr/db';
import type { Registry } from '@hykr/ui-registry';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { ModuleDef } from './module.js';

const WRITES = ['create', 'update', 'delete'];
const ENTITY_EVENT = /^(.+)\.(created|updated|deleted)$/;

/** `schema.name` of every drizzle table in a namespace. */
function tablesIn(namespace: Readonly<Record<string, unknown>>): string[] {
  return Object.values(namespace)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => {
      const { name, schema } = getTableConfig(table);
      return `${schema ?? 'public'}.${name}`;
    });
}

/** Problems with the modules' tables: named after their module, unique, not the framework's. */
export function tableProblems(modules: readonly ModuleDef[], prefix = ''): string[] {
  const problems: string[] = [];
  const framework = new Set(tablesIn(frameworkSchema));
  const owners = new Map<string, string>();
  for (const m of modules) {
    for (const qualified of tablesIn(m.tables ?? {})) {
      const name = qualified.slice(qualified.indexOf('.') + 1);
      const base = `${prefix}${m.name}`;
      if (name !== base && !name.startsWith(`${base}_`))
        problems.push(`${m.name}: the table ${qualified} must be named ${base} or ${base}_…`);
      if (framework.has(qualified))
        problems.push(`${m.name}: the table ${qualified} is one of the framework's`);
      const taken = owners.get(qualified);
      if (taken !== undefined && taken !== m.name)
        problems.push(`The table ${qualified} is declared by both ${taken} and ${m.name}`);
      owners.set(qualified, m.name);
    }
  }
  return problems;
}

/**
 * Everything one part names in another: a spec's views, a command's view, a view's source entity,
 * its actions' commands and screens, a notification's entity events, and scripts that would take
 * another module's eval turns.
 */
export function crossProblems(input: {
  modules: readonly ModuleDef[];
  catalog: Catalog;
  registry: Registry;
}): string[] {
  const { modules, catalog, registry } = input;
  const problems: string[] = [];
  const view = (name: string | undefined, what: string) => {
    if (name && !registry.getViewDef(name)) problems.push(`${what} is shown as ${name}, no view`);
  };
  for (const m of modules) {
    for (const spec of Object.values(m.entities) as EntitySpec[]) {
      view(spec.views?.list, `${m.name}: the ${spec.name} list`);
      view(spec.views?.item, `${m.name}: one ${spec.name}`);
    }
    for (const spec of m.commands) view(spec.view?.name, `${m.name}: the result of ${spec.name}`);
    for (const def of m.views ?? []) {
      const source = def.source?.entity.name;
      if (source && !catalog.entityByName(source))
        problems.push(`${m.name}: the view ${def.name} lists ${source}, which is no entity`);
      for (const [key, action] of Object.entries(def.actions)) {
        if ('screen' in action && !registry.getScreenDef(action.screen))
          problems.push(`${m.name}: ${def.name}'s action ${key} opens ${action.screen}, no screen`);
        if ('command' in action) {
          const [entity, op] = [
            action.command.slice(0, action.command.lastIndexOf('.')),
            action.command.slice(action.command.lastIndexOf('.') + 1),
          ];
          const known =
            catalog.commandByName(action.command) ||
            (catalog.entityByName(entity) && WRITES.includes(op));
          if (!known)
            problems.push(
              `${m.name}: ${def.name}'s action ${key} runs ${action.command}, no command`,
            );
        }
      }
    }
    for (const n of m.notifications ?? []) {
      const events = [
        ...(n.schedule?.on ?? []),
        ...(n.schedule?.cancelOn ?? []),
        ...(n.send?.on ?? []),
      ];
      for (const event of events) {
        const entity = ENTITY_EVENT.exec(event)?.[1];
        if (entity && !catalog.entityByName(entity))
          problems.push(`${m.name}: the notification ${n.key} follows ${event}, no entity's event`);
      }
    }
  }
  problems.push(...scriptConflicts(modules));
  return problems;
}
