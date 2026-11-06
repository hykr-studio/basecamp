import { z } from 'zod';
import { MimeType } from '../framework/files.js';

/**
 * Files, as `/api/files` shows them: uploaded in three steps (presign, PUT the bytes, confirm),
 * then kept on a record by putting the id in one of its file fields (see framework/files.ts).
 */

/** Uploaded but not confirmed yet, or ready to use. */
export const FileStatus = z.enum(['pending', 'ready']);
export type FileStatus = z.infer<typeof FileStatus>;

/** Where a file came from: a person's upload, a WhatsApp message, or the server itself. */
export const FileSource = z.enum(['upload', 'whatsapp', 'server']);
export type FileSource = z.infer<typeof FileSource>;

/** The record field a file is kept on. */
export const FileOwner = z.object({ entity: z.string(), id: z.string(), field: z.string() });
export type FileOwner = z.infer<typeof FileOwner>;

export const FileInfo = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  /** Bytes. */
  size: z.number().int(),
  status: FileStatus,
  source: FileSource,
  /** An image's size in pixels, when it could be read. */
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** An audio file's words, once transcribed, and their language. */
  transcript: z.string().nullable(),
  transcriptLang: z.string().nullable(),
  /** The record it is on; null until a write puts it on one. */
  attachedTo: FileOwner.nullable(),
  createdAt: z.iso.datetime(),
  /** A short-lived download address, for a ready file. Relative ones are relative to the API. */
  url: z.string().optional(),
  urlExpiresAt: z.iso.datetime().optional(),
});
export type FileInfo = z.infer<typeof FileInfo>;

/** What a file is uploaded for: one entity's file field, and the record when it exists. */
export const FileTarget = z.object({
  entity: z.string().min(1).max(64),
  field: z.string().min(1).max(64),
  /** The record it will go on, when it exists already: the person must be able to update it. */
  id: z.uuid().optional(),
});
export type FileTarget = z.infer<typeof FileTarget>;

export const PresignFileInput = z.object({
  name: z.string().min(1).max(255),
  mime: MimeType,
  size: z.number().int().positive(),
  for: FileTarget,
});
export type PresignFileInput = z.input<typeof PresignFileInput>;

/** Where to PUT the bytes: send exactly these headers, and exactly `size` bytes, before it expires. */
export const FileUpload = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type FileUpload = z.infer<typeof FileUpload>;

export const PresignFileResult = z.object({ file: FileInfo, upload: FileUpload });
export type PresignFileResult = z.infer<typeof PresignFileResult>;

/** An audio file's words. */
export const FileTranscript = z.object({ text: z.string(), lang: z.string().nullable() });
export type FileTranscript = z.infer<typeof FileTranscript>;
