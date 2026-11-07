import { z } from 'zod';
import { defineSettingsSection } from './sections.js';

declare module './sections.js' {
  interface TenantSettingsSections {
    shares: SharesSettings;
  }
}

/**
 * How long a business's share links last (docs/decisions/B9.md): `defaultDays` when the person
 * making one says nothing, at most `maxDays`; and how long a device sees a gated link after its
 * code (`sessionHours`, never past the link's end).
 */
export const SharesSettings = z
  .object({
    defaultDays: z.number().int().min(1).max(3650).default(7),
    maxDays: z.number().int().min(1).max(3650).default(90),
    sessionHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(12),
  })
  .default({ defaultDays: 7, maxDays: 90, sessionHours: 12 });
export type SharesSettings = z.infer<typeof SharesSettings>;

export const SharesSection = defineSettingsSection('shares', SharesSettings);
