import { z } from 'zod';
import { defineSettingsSection } from './sections.js';

declare module './sections.js' {
  interface TenantSettingsSections {
    parties: PartiesSettings;
  }
}

/**
 * How a business meets people it does not know yet. `unknownSenders`: someone who writes to its
 * WhatsApp number for the first time becomes a `customer` (a customer record, as before), or
 * only a `contact` (no customer record: they reach nothing until the business puts them on a
 * record or links them to a customer).
 */
export const PartiesSettings = z
  .object({ unknownSenders: z.enum(['customer', 'contact']).default('customer') })
  .default({ unknownSenders: 'customer' });
export type PartiesSettings = z.infer<typeof PartiesSettings>;

export const partiesSettings = defineSettingsSection('parties', PartiesSettings);
