import type { AgentModule } from '@hykr/agents';
import {
  type CommandSpec,
  type Contributions,
  type EntitySpec,
  type ModuleSpec,
  moduleSpec,
} from '@hykr/contracts';
import type { NotificationDef, TemplateDef } from '@hykr/notifications';
import type { ScreenDef, ViewDef } from '@hykr/ui-registry';
import type { DynamicModule, Type } from '@nestjs/common';

/**
 * One application module, server side: its specs, the Nest module that serves them, its views
 * and screens, what it sends, what it teaches the assistant, its tables and the hooks it
 * contributes. Teams build modules in parallel, each in its own folder
 * (`application/domain/src/modules/<name>/`); `defineServer({ modules })` merges them and checks
 * at boot that they fit together.
 */
export interface ModuleDef<
  E extends Record<string, EntitySpec> = Record<string, EntitySpec>,
  C extends readonly CommandSpec[] = readonly CommandSpec[],
> extends ModuleSpec<E, C> {
  /** The Nest module with one `defineEntity` / `defineCommand` per spec. */
  server?: Type<unknown> | DynamicModule;
  views?: readonly ViewDef[];
  screens?: readonly ScreenDef[];
  // biome-ignore lint/suspicious/noExplicitAny: notifications over different rows
  notifications?: readonly NotificationDef<any>[];
  templates?: readonly TemplateDef[];
  agent?: AgentModule;
  /**
   * Its tables: the module's `db/schema.ts` namespace (`import * as tables`). Checked at boot:
   * each drizzle table is named after the module (`orders`, `orders_lines`), and no two modules
   * or the framework share a name.
   */
  tables?: Readonly<Record<string, unknown>>;
  /** Its hooks and plugins, by kind (see `Contributions`). */
  contributes?: Partial<Contributions>;
}

/**
 * Declare a module: checks its name and plural keys and stamps every spec with the module's id
 * (as `moduleSpec` does for the module's isomorphic half, which it may already have done).
 */
export function defineModule<
  const E extends Record<string, EntitySpec>,
  const C extends readonly CommandSpec[],
>(def: ModuleDef<E, C>): ModuleDef<E, C> {
  moduleSpec(def);
  return def;
}
