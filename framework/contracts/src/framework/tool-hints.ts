// What a write does, for an outside AI client deciding when to ask the person first (MCP tool
// annotations, H3): whether an action can delete or do something that cannot be undone. An entity
// delete and a command served over HTTP DELETE always can; anything else only when the
// application marks it, because what cannot be undone changes with the business.
import type { CommandSpec } from './spec.js';
import type { TransitionDecl } from './states.js';

declare module './traits.js' {
  interface CommandTraits {
    /** It deletes records or does something that cannot be undone (`traits: { destructive: true }`). */
    destructive?: boolean;
  }
}

declare module './states.js' {
  interface TransitionDecl {
    /** The move cannot be undone (a cancel that ends the record). Default false. */
    destructive?: boolean;
  }
}

/** Can this command delete or do something that cannot be undone? */
export const isDestructiveCommand = (spec: Pick<CommandSpec, 'http' | 'traits'>): boolean =>
  spec.http.method === 'DELETE' || spec.traits?.destructive === true;

/** Can this state transition not be undone? */
export const isDestructiveTransition = (t: Pick<TransitionDecl, 'destructive'>): boolean =>
  t.destructive === true;
