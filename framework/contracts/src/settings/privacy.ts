// A business's own privacy settings (B18): when it answers requests, which requests a person on
// its team reviews first, how long it keeps personal data, and the processors it uses besides
// the application's. Every field defaults to empty: a new business follows the application's
// policy as declared. docs/decisions/B18.md.
import { z } from 'zod';
import { defineSettingsSection } from './sections.js';

/** The kinds of request a person can make about their personal data. */
export const PrivacyRequestKind = z.enum(['export', 'erase']);
export type PrivacyRequestKind = z.infer<typeof PrivacyRequestKind>;

/** Someone who processes personal data for the business: a service it uses. */
export const ProcessorRecord = z.object({
  name: z.string().trim().min(1).max(120),
  /** What they do with it, in the business's words. */
  purpose: z.string().trim().min(1).max(500),
  /** The kinds of personal data they get ('phone number', 'messages'). */
  data: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  /** Where they keep it (a country or region). */
  location: z.string().trim().max(120).optional(),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
});
export type ProcessorRecord = z.infer<typeof ProcessorRecord>;

export const PrivacySettings = z
  .object({
    /**
     * Answer a request within this many days of receiving it. Unset: the application's policy,
     * else no deadline.
     */
    respondWithinDays: z.int().min(1).max(365).optional(),
    /**
     * Requests a person makes about themselves that wait for someone with `privacy.manage` before
     * they run, besides those the application's policy reviews. Requests the team files run at
     * once.
     */
    review: z.array(PrivacyRequestKind).default([]),
    /**
     * Retention periods in whole days, by rule or target name ('notes.personal'), over the
     * application's; null keeps that data (the rule does not run here).
     */
    retention: z.record(z.string(), z.int().min(1).max(36_500).nullable()).default({}),
    /** The business's own processors, listed on its register after the application's. */
    processors: z.array(ProcessorRecord).max(50).default([]),
  })
  .prefault({});
export type PrivacySettings = z.infer<typeof PrivacySettings>;

declare module './sections.js' {
  interface TenantSettingsSections {
    privacy: PrivacySettings;
  }
}

export const PrivacySection = defineSettingsSection('privacy', PrivacySettings);
