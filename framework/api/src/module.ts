import type { AgentModule } from '@hykr/agents';
import type { CommandSpec, Contributions, EntitySpec, ModuleSpec } from '@hykr/contracts';
import type { NotificationDef, TemplateDef } from '@hykr/notifications';
import type { ScreenDef, ViewDef } from '@hykr/ui-registry';
import type { DynamicModule, Type } from '@nestjs/common';

/**
 * One application module, server side: its specs, the Nest module that serves them, its views
 * and screens, what it sends, what it teaches the assistant, and the hooks it contributes.
 * Teams build modules in parallel, each in its own folder. Only the shape is declared here:
 * `defineModule` and merging modules into one server come with the module system.
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
  /** Its hooks and plugins, by kind (see `Contributions`). */
  contributes?: Partial<Contributions>;
}
