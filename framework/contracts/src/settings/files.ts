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
 * `readInbound`: the assistant may read a photo or PDF sent on WhatsApp in the turn it came with,
 * before it is on any record (on by default; files on records are read either way).
 */
export const FilesSettings = z
  .object({
    keepInboundMedia: z.boolean().default(true),
    readInbound: z.boolean().default(true),
  })
  .default({ keepInboundMedia: true, readInbound: true });
export type FilesSettings = z.infer<typeof FilesSettings>;

export const filesSettings = defineSettingsSection('files', FilesSettings, { editable: true });
