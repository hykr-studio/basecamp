import { z } from 'zod';
import { type Duration, durationMs } from '../framework/states.js';
import { defineSettingsSection } from './sections.js';

/**
 * The longest SLA a business can set: ten years. `durationMs` takes any safe integer of
 * milliseconds (285,000 years), and a due time that far on is one Postgres cannot store, a 500
 * at the next transition (docs/decisions/V10.md). Business-time arithmetic counts ten years too.
 */
const LONGEST_MS = 3653 * 86_400_000;

const DurationSetting = z
  .union([z.number().int().positive(), z.string().regex(/^\d+(?:\.\d+)?[mh]$/)])
  .refine((d) => {
    try {
      durationMs(d as Duration);
      return true;
    } catch {
      return false;
    }
  }, "A duration: '30m', '48h' or milliseconds")
  .refine((d) => {
    try {
      return durationMs(d as Duration) <= LONGEST_MS;
    } catch {
      return true; // The refinement above reports it.
    }
  }, 'A duration of at most ten years');

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

export const SlaSection = defineSettingsSection('sla', SlaSettings, { editable: true });
