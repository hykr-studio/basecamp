// Exporting a business's data (A11X): a person who may (`data.export`) starts an export; the
// worker reads every entity as that person (their access, grants and hidden fields apply) and
// keeps one zip archive of JSON and CSV files on the export's job (docs/decisions/A11X.md).
import { z } from 'zod';
import { commandSpec } from '../framework/spec.js';
import { capabilities, defineCapability } from '../roles.js';
import { JobInfo } from './job.js';

/** Take the business's data out: every record the person reads, as JSON and CSV files. */
export const DataExportCapability = defineCapability({
  name: 'data.export',
  label: {
    en: "Export the business's data",
    hi: 'व्यवसाय का डेटा निर्यात करें',
    te: 'వ్యాపార డేటాను ఎగుమతి చేయండి',
  },
  roles: ['owner'],
  // The business's data leaving it: never support's.
  supportable: false,
});
capabilities.register(DataExportCapability);

/** The kind of job an export runs as (`/api/jobs?kind=export.data`). */
export const DATA_EXPORT_JOB = 'export.data';

/** The files each part is written as. */
export const ExportFormat = z.enum(['json', 'csv']);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** A part's name: an entity's name ('task') or an export source's ('audit-log'). */
const PartName = z.string().min(1).max(64);

export const StartExportInput = z.object({
  /** Both by default. */
  formats: z.array(ExportFormat).min(1).max(2).optional(),
  /** Only these entities (by name) and export sources; everything by default. */
  only: z.array(PartName).min(1).max(200).optional(),
});
export type StartExportInput = z.input<typeof StartExportInput>;

export const StartExportSpec = commandSpec({
  name: 'export.start',
  description:
    "Export the business's records you can read, as JSON and CSV files in one zip archive. It runs as a job: follow it, then download the archive.",
  input: StartExportInput,
  output: JobInfo,
  http: { method: 'POST', path: '/api/exports' },
  expose: 'human',
  verb: { do: 'export the data', did: 'exported the data' },
  touches: [],
});

/** One entity or export source in an export: how many rows, and its files in the archive. */
export const ExportPart = z.object({
  name: z.string(),
  kind: z.enum(['entity', 'source']),
  /** The module that declares the entity, when it is a module's. */
  module: z.string().nullable(),
  /** The entity's label ('task'); a source's name. */
  label: z.string(),
  rows: z.number().int().min(0),
  files: z.array(z.string()),
});
export type ExportPart = z.infer<typeof ExportPart>;

/** Why an entity is not in the export. */
export const ExportSkipReason = z.enum([
  /** People cannot list it either (`expose.list: 'internal'`). */
  'not_listed',
  /** A feature flag has it switched off for the business. */
  'switched_off',
  /** Its plugins refuse this person's list (a sort on a field hidden from them). */
  'refused',
]);
export const ExportSkipped = z.object({ name: z.string(), reason: ExportSkipReason });
export type ExportSkipped = z.infer<typeof ExportSkipped>;

/** What a finished export's job says it made (the archive itself is its result file). */
export const ExportOutput = z.object({
  /** Rows in every part together. */
  rows: z.number().int().min(0),
  /** The archive's size. */
  bytes: z.number().int().min(0),
  formats: z.array(ExportFormat),
  parts: z.array(ExportPart.omit({ files: true })),
  skipped: z.array(ExportSkipped),
});
export type ExportOutput = z.infer<typeof ExportOutput>;

/** The archive's `manifest.json`: what is in it, and whose view of the data it is. */
export const ExportManifest = z.object({
  version: z.literal(1),
  tenantId: z.string(),
  exportedAt: z.iso.datetime(),
  /** Whose view of the data this is: their access and hidden fields applied. */
  exportedBy: z.object({ kind: z.string(), id: z.string() }),
  formats: z.array(ExportFormat),
  parts: z.array(ExportPart),
  skipped: z.array(ExportSkipped),
});
export type ExportManifest = z.infer<typeof ExportManifest>;
