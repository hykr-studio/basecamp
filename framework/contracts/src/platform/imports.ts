// Bulk import (B20): a file of one entity's records (CSV, JSON or NDJSON) written through the
// write path by a job, row by row, as the person who started it. Each row carries its id in the
// other system (its key); the business keeps which record each key became, so running the same
// import again updates those records instead of making them twice. Rows that could not be
// written come back in an error report file. People with `imports.run` start one with
// `POST /api/imports` (or `basecamp import`); the assistant reads its job but never starts one.
import { z } from 'zod';
import { FileRef } from '../framework/files.js';
import { commandSpec } from '../framework/spec.js';
import { capabilities, defineCapability } from '../roles.js';
import { JobInfo } from './job.js';

/** Import records from files. The framework gives it to owners and admins. */
export const ImportsCapability = defineCapability({
  name: 'imports.run',
  label: {
    en: 'Import records from files',
    hi: 'फ़ाइलों से रिकॉर्ड आयात करें',
    te: 'ఫైళ్ల నుండి రికార్డులను దిగుమతి చేయండి',
  },
  roles: ['owner', 'admin'],
  supportable: true,
});
capabilities.register(ImportsCapability);

/** What a file is upload for, when it is to be imported: `POST /api/files { for }`. */
export const IMPORT_UPLOAD = { entity: 'import', field: 'file' } as const;

/** The file types an import reads. */
export const IMPORT_MIME_TYPES = [
  'text/csv',
  'text/plain',
  'application/json',
  'application/x-ndjson',
] as const;

/** CSV (a header row, then one row per record), JSON (an array of objects), or NDJSON. */
export const ImportFormat = z.enum(['csv', 'json', 'ndjson']);
export type ImportFormat = z.infer<typeof ImportFormat>;

/** A column of the file or a field of the entity. */
const Name = z.string().min(1).max(200);
const FieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const EntityName = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);

/** The other system's name, which keys are unique within: 'legacy-crm'. */
export const ImportSource = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
  message: 'A source is lower case letters, digits, ".", "_" or "-"',
});

const atMost =
  (n: number) =>
  (r: Record<string, unknown> | undefined): boolean =>
    !r || Object.keys(r).length <= n;

/** What to import and how (`POST /api/imports`, the job's input). */
export const ImportOptions = z.object({
  /** The entity's name: 'todo'. */
  entity: EntityName,
  /** The file: the starter's own upload (`for: IMPORT_UPLOAD`), or one the server stored. */
  file: FileRef,
  /** Default: from the file's type and name. */
  format: ImportFormat.optional(),
  /** The column with each row's id in the other system. Default 'id'. */
  key: Name.default('id'),
  /** The other system: keys are unique per business, entity and source. Default 'default'. */
  source: ImportSource.default('default'),
  /** A file column → the field it fills, or null to leave the column out. */
  columns: z
    .record(Name, FieldName.nullable())
    .optional()
    .refine(atMost(500), { message: 'At most 500 columns' }),
  /**
   * A field → the entity whose keys (in the same source) the column holds: each is looked up
   * among the records imported before, and becomes that record's id.
   */
  refs: z
    .record(FieldName, EntityName)
    .optional()
    .refine(atMost(50), { message: 'At most 50 references' }),
  /** A row imported before: update its record with the row's values, or leave it. */
  existing: z.enum(['update', 'skip']).default('update'),
  /** An empty CSV cell: leave the field out, or set it to null where it may be null. */
  empty: z.enum(['omit', 'null']).default('omit'),
  /** Check every row as a real import would, and write nothing. */
  dryRun: z.boolean().default(false),
});
export type ImportOptions = z.infer<typeof ImportOptions>;
export type ImportOptionsInput = z.input<typeof ImportOptions>;

/** Why a row was not written (the error report's `_code`). */
export const ImportErrorCode = z.enum([
  /** The entity's schema refused a value. */
  'invalid',
  /** The row has no key. */
  'missing_key',
  /** Another row of the file has the same key. */
  'duplicate_key',
  /** A `refs` column names a record that was not imported, or that the importer cannot reach. */
  'unknown_reference',
  /** The record this key became is gone, or the importer no longer reaches it. */
  'not_found',
  /** Access, a rule, a field policy or a feature flag refused the write. */
  'forbidden',
  /** The write would wait for an approval: imports never park rows. */
  'needs_approval',
  /** The record changed meanwhile, or another import wrote this key first. */
  'conflict',
  /** Anything else (a database constraint). */
  'failed',
]);
export type ImportErrorCode = z.infer<typeof ImportErrorCode>;

const Count = z.number().int().min(0);

/** What an import did (or, for a dry run, would do): the job's output. */
export const ImportResult = z.object({
  entity: z.string(),
  source: z.string(),
  dryRun: z.boolean(),
  /** Data rows in the file. */
  rows: Count,
  created: Count,
  updated: Count,
  /** Imported before, and the row changes nothing. */
  unchanged: Count,
  /** Imported before, left alone (`existing: 'skip'`). */
  skipped: Count,
  /** Not written: each is in the error report. */
  failed: Count,
  /** Failed rows by code. */
  errors: z.record(z.string(), Count),
  /** Rows in the error report (a result file of the job); 0: no report. */
  reportRows: Count,
  /** The report was cut at its limit: more rows failed than it lists. */
  reportTruncated: z.boolean(),
});
export type ImportResult = z.infer<typeof ImportResult>;

/** Start an import: a job (`imports.records`) that the worker runs. People with `imports.run`. */
export const StartImportSpec = commandSpec({
  name: 'import.start',
  description:
    'Import records of one entity from an uploaded CSV, JSON or NDJSON file, through the write path. Rows imported before (same key and source) are updated, not made again.',
  input: ImportOptions,
  output: JobInfo,
  http: { method: 'POST', path: '/api/imports' },
  expose: 'human',
  verb: { do: 'import', did: 'imported' },
});
