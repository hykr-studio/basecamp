// Platform-scoped shared records (A11): rows the platform's business keeps that every business
// reads, read-only, unless it overrides one with a row of its own. What is shared is the
// application's data (a catalog, say); the mechanism is `defineSharedEntity` in @hykr/core.
import { z } from 'zod';

declare module './traits.js' {
  interface EntityTraits {
    /** Every business reads the platform's rows of it, and may override one with its own. */
    shared?: Record<string, never>;
  }
}

/**
 * What a shared entity's read schema carries besides its own fields: `shared`, true for a row the
 * platform keeps (read-only here), and `sharedId`, the platform row a business's row overrides.
 */
export const SharedFields = {
  shared: z.boolean(),
  sharedId: z.string().nullable(),
};

/** In a create: the platform row this new row overrides (a copy the business changes). */
export const SharedFromInput = { sharedId: z.uuid().optional() };
