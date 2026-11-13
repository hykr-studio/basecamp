import { z } from 'zod';
import { defineCapability } from '../roles.js';
import { defineSettingsSection } from './sections.js';

declare module './sections.js' {
  interface TenantSettingsSections {
    support: SupportSettings;
  }
}

/**
 * How a business lets the platform's operators work in it (B19). `requests`: whether operators
 * may ask at all (each request still waits for the business's consent). `maxMinutes`: the longest
 * access the business consents to. `requestHours`: how long a request waits for an answer before
 * it expires.
 */
export const SupportSettings = z
  .object({
    requests: z.boolean().default(true),
    maxMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .default(480),
    requestHours: z
      .number()
      .int()
      .min(1)
      .max(30 * 24)
      .default(72),
  })
  .default({ requests: true, maxMinutes: 480, requestHours: 72 });
export type SupportSettings = z.infer<typeof SupportSettings>;

export const supportSettings = defineSettingsSection('support', SupportSettings);

/** What `PUT /api/support-access/settings` takes: the whole section. */
export const SupportSettingsInput = z
  .object({
    requests: z.boolean(),
    maxMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60),
    requestHours: z
      .number()
      .int()
      .min(1)
      .max(30 * 24),
  })
  .strict();
export type SupportSettingsInput = z.infer<typeof SupportSettingsInput>;

/** See the platform's requests for support access, consent, decline and end them. */
export const SupportConsentCapability = defineCapability({
  name: 'support.consent',
  label: {
    en: 'Let platform support work in the business',
    hi: 'प्लैटफ़ॉर्म सहायता को व्यवसाय में काम करने दें',
    te: 'ప్లాట్‌ఫామ్ సహాయాన్ని వ్యాపారంలో పని చేయనివ్వండి',
  },
  roles: ['owner'],
  supportable: false,
});
