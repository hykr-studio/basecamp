import { type DynamicModule, Module } from '@nestjs/common';
import type { FeatureDef } from './feature.js';
import { installFeatures } from './install.js';

/** One Nest module class per feature: Nest tells modules apart by their class. */
function moduleOf(f: FeatureDef, opts: { http: boolean; processors: boolean }): DynamicModule {
  const name = `${f.name.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())}Feature`;
  const host = { [name]: class {} }[name];
  Module({})(host);
  return {
    module: host,
    imports: f.imports ?? [],
    controllers: opts.http ? (f.controllers ?? []) : [],
    providers: [...(f.providers ?? []), ...(opts.processors ? (f.processors ?? []) : [])],
    exports: f.exports ?? [],
  };
}

/**
 * The framework's features (features/index.ts), each as its own Nest module. The API passes
 * `{ http: true, processors: WORKER_INLINE }`, the worker `{ http: false, processors: true }`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest's dynamic-module pattern
export class FeaturesModule {
  static forRoot(opts: { http: boolean; processors: boolean }): DynamicModule {
    return { module: FeaturesModule, imports: installFeatures().map((f) => moduleOf(f, opts)) };
  }
}
