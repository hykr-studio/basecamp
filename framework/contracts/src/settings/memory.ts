import { z } from 'zod';
import { defineSettingsSection } from './sections.js';

/**
 * How the assistant recalls memory for one business. Recall also needs an embedding model the
 * business's model policy allows (the `models` section): without one, nothing is recalled.
 */
export const MemoryPolicy = z
  .object({
    /** Recall memory before each turn (and keep the person's words for later recall). */
    recall: z.boolean().default(true),
    /** Include what the person said in earlier turns, on any channel. */
    conversation: z.boolean().default(true),
    /** At most this many memories reach one turn. */
    limit: z.int().min(0).max(10).default(5),
    /** The lowest similarity (cosine, 0 to 1) a memory needs to be recalled. */
    minScore: z.number().min(0).max(1).default(0.3),
  })
  .prefault({});
export type MemoryPolicy = z.infer<typeof MemoryPolicy>;

declare module './sections.js' {
  interface TenantSettingsSections {
    memory: MemoryPolicy;
  }
}

export const MemorySettings = defineSettingsSection('memory', MemoryPolicy, { editable: true });
