import { z } from 'zod';
import type { EntitySpec } from './spec.js';

/**
 * File fields: a record keeps files (photos, documents, voice notes) by id. The spec says which
 * fields hold files and what each accepts; the field itself is a `FileRef` (one file, nullable)
 * or `fileRefs()` (a list). Files are uploaded to `/api/files` first, then a write puts their ids
 * in the field. From then on a file is reached only through the record that holds it.
 *
 *   schemas: { read: z.object({ …, photos: fileRefs(10) }), … },
 *   traits: { files: { photos: { accept: ['image/*'], maxBytes: 10_000_000, max: 10 } } },
 */
declare module './traits.js' {
  interface EntityTraits {
    /** The fields that hold files, by field name, with what each accepts. */
    files?: Readonly<Record<string, FileFieldPolicy>>;
  }
}

/** What one file field accepts. */
export interface FileFieldPolicy {
  /**
   * Media types: exact ('application/pdf') or a family ('image/*'). A family never matches
   * SVG ('image/svg+xml'), which can carry scripts: name it to accept it. Absent: any type.
   */
  accept?: readonly string[];
  /** The largest file, in bytes. The deployment's own cap still applies. */
  maxBytes?: number;
  /** How many files a list field holds at most. Default 20. */
  max?: number;
}

/** The default number of files a list field may hold. */
export const DEFAULT_MAX_FILES = 20;

/** One file on a record: its id, as `/api/files` gave it. */
export const FileRef = z
  .uuid()
  .describe(
    'A file id. Files are uploaded first; a file sent on WhatsApp is named in the message with its id. Put the id here to keep the file on this record.',
  );
export type FileRef = z.infer<typeof FileRef>;

/** Several files on a record, in order: at most `max` ids. */
export const fileRefs = (max = DEFAULT_MAX_FILES) =>
  z
    .array(FileRef)
    .max(max)
    .describe(
      'File ids, in order. Send the whole list: ids left out are taken off the record. A new file is uploaded first, or named in a WhatsApp message with its id.',
    );

/** A media type: lower case `type/subtype`. */
export const MimeType = z
  .string()
  .max(255)
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/));

/** The file fields a spec declares, with their policies, in declaration order. */
export function fileFieldsOf(
  spec: Pick<EntitySpec, 'traits'> | undefined,
): [field: string, policy: FileFieldPolicy][] {
  return Object.entries(spec?.traits?.files ?? {});
}

/** The media type without parameters, lower case: 'image/jpeg; q=1' → 'image/jpeg'. */
export const baseMime = (mime: string) => mime.split(';')[0].trim().toLowerCase();

/** Does this field accept a file of this type? */
export function acceptsMime(policy: FileFieldPolicy, mime: string): boolean {
  const type = baseMime(mime);
  if (!policy.accept) return true;
  return policy.accept.some((entry) => {
    const want = baseMime(entry);
    if (want === '*/*') return type !== 'image/svg+xml';
    if (want.endsWith('/*')) return type.startsWith(want.slice(0, -1)) && type !== 'image/svg+xml';
    return want === type;
  });
}

/** The file ids in a field's value: one id, a list of them, or nothing. */
export function fileIdsIn(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
  return [];
}
