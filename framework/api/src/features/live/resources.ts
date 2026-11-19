// Which records a live update may name to a person. Nothing here reads the configuration or
// loads Nest: safe to import from an application module at load time.
import { createHookRegistry, type Principal } from '@hykr/contracts';
import type { ServerContext } from '../../hooks.js';

declare module '@hykr/contracts' {
  interface Contributions {
    liveResources: readonly LiveResource[];
  }
}

/**
 * How the live stream checks a record type that is not an entity (an approval, a feature's own
 * record): may this person read this record now? An entity's records need none: they are checked
 * with the entity's own scoped read, as GET does. A type with no check is never sent.
 */
export interface LiveResource {
  /** The record type, as events and audit name it: 'approval'. Unique. */
  type: string;
  /** Read access now. Throwing counts as no. */
  visible(p: Principal, id: string, ctx: ServerContext): Promise<boolean>;
}

/** Live checks, by record type. Contribute them as `liveResources`. */
export const liveResources = createHookRegistry<LiveResource>('live resource', (r) => r.type, {
  collects: 'liveResources',
});
