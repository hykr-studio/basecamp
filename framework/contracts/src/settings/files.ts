import { z } from 'zod';
import { defineSettingsSection } from './sections.js';

declare module './sections.js' {
  interface TenantSettingsSections {
    files: FilesSettings;
  }
}

/**
 * A business's file settings. `keepInboundMedia`: photos, documents and videos people send on
 * WhatsApp are stored as files the assistant can put on a record (on by default).
 */
export const FilesSettings = z
  .object({ keepInboundMedia: z.boolean().default(true) })
  .default({ keepInboundMedia: true });
export type FilesSettings = z.infer<typeof FilesSettings>;

export const filesSettings = defineSettingsSection('files', FilesSettings);
