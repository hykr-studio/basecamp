import { z } from 'zod';
import { type Duration, durationMs } from '../framework/states.js';
import { defineSettingsSection } from './sections.js';

const DurationSetting = z
  .union([z.number().int().positive(), z.string().regex(/^\d+(?:\.\d+)?[mh]$/)])
  .refine((d) => {
    try {
      durationMs(d as Duration);
      return true;
    } catch {
      return false;
    }
  }, "A duration: '30m', '48h' or milliseconds");

/**
 * A business's own SLA durations, by the SLA's name ('orders.decision'), over the module's,
 * and the SLAs it switched off. Every SLA a module declares runs as declared otherwise.
 */
export const SlaSettings = z
  .object({
    within: z.record(z.string(), DurationSetting).default({}),
    off: z.array(z.string()).default([]),
  })
  .default({ within: {}, off: [] });
export type SlaSettings = z.infer<typeof SlaSettings>;

declare module './sections.js' {
  interface TenantSettingsSections {
    sla: SlaSettings;
  }
}

export const SlaSection = defineSettingsSection('sla', SlaSettings);
