import type { Contributions } from '@hykr/contracts';
import type { DynamicModule, ForwardReference, Provider, Type } from '@nestjs/common';

/**
 * One framework feature (credits, files, memory): a Nest module in its own folder,
 * `framework/api/src/features/<name>/`, exported from `features/index.ts` on one line.
 * `FeaturesModule.forRoot` loads every feature into the API and the worker:
 * - `controllers` only where HTTP is served (the API);
 * - `processors` (BullMQ `@Processor` classes, pollers) only where jobs run (the worker, or the
 *   API with WORKER_INLINE=1);
 * - `providers` everywhere.
 * `contributes` is installed once per process, before the queues are registered, so a feature's
 * queues, schedules, subscribers and hooks are in their registries before anything reads them.
 */
export interface FeatureDef {
  /** Lower case, unique: 'credits'. Prefixes its queues, schedules and subscribers. */
  name: string;
  /** Off in this deployment (a missing setting): nothing of it loads. Default: on. */
  enabled?(): boolean;
  imports?: (Type | DynamicModule | Promise<DynamicModule> | ForwardReference)[];
  controllers?: Type[];
  providers?: Provider[];
  processors?: Provider[];
  exports?: (string | symbol | Type | Provider | DynamicModule)[];
  contributes?: Partial<Contributions>;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const FEATURE = Symbol.for('@hykr/api/feature');

/** A feature, checked: its name. */
export function defineFeature(def: FeatureDef): FeatureDef {
  if (!NAME.test(def.name))
    throw new Error(`Feature name "${def.name}" must be lower case letters, digits and "-"`);
  return Object.assign(def, { [FEATURE]: true });
}

/** What `features/index.ts` exports besides features is ignored. */
export const isFeature = (x: unknown): x is FeatureDef =>
  typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[FEATURE] === true;
