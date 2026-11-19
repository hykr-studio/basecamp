// The export, as a job: started by `export.start`, run in the worker as the person who asked.
import {
  DATA_EXPORT_JOB,
  DataExportCapability,
  ExportFormat,
  ExportOutput,
  type Principal,
} from '@hykr/contracts';
import { can } from '@hykr/policy';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { runtime } from '../../runtime.js';
import { FilesService } from '../files/files.service.js';
import { defineJob, type SubmitContext, type SubmitResult } from '../jobs/define.js';
import { FeatureGates } from '../settings/gates.js';
import { buildExport, ExportTooLarge, planExport } from './build.js';

export const ExportJobInput = z.object({
  formats: z.array(ExportFormat).min(1),
  only: z.array(z.string()).optional(),
});
export type ExportJobInput = z.infer<typeof ExportJobInput>;

/** Its archive's name: `export-<date>.zip`, the UTC date it was made. */
export const archiveName = (at: Date) => `export-${at.toISOString().slice(0, 10)}.zip`;

const failed = (code: string, message: string): SubmitResult => ({
  update: { status: 'failed', error: { code, message } },
});

/** Reads the business as its starter and returns the archive (docs/decisions/A11X.md). */
async function runExport(ctx: SubmitContext<ExportJobInput>): Promise<SubmitResult> {
  const { tenantId, input } = ctx.job;
  let p: Principal;
  try {
    p = await ctx.starter();
  } catch (e) {
    // Left the business, or the account is gone: nobody to read as.
    if (e instanceof HttpException && e.getStatus() < 500)
      return failed(
        'starter_unavailable',
        'Whoever started this export can no longer read the business',
      );
    throw e;
  }
  if (p.actor.kind === 'system' || p.tenantId !== tenantId || !can(p, DataExportCapability))
    return failed('needs_data_export', 'Whoever started this export may no longer export data');

  const off = await ctx.get(FeatureGates).off(tenantId);
  const { catalog } = runtime();
  const at = new Date();
  try {
    const built = await buildExport({
      principal: p,
      tenantId,
      db: ctx.db,
      formats: [...new Set(input.formats)],
      plan: planExport(input.only, off, catalog),
      catalog,
      maxBytes: ctx.get(FilesService).config.maxBytes,
      signal: ctx.signal,
      at,
      progress: (percent, message) => ctx.progress(percent, message),
      get: ctx.get,
    });
    return {
      update: { status: 'succeeded', output: built.output, message: 'Ready' },
      files: [{ name: archiveName(at), mime: 'application/zip', bytes: built.archive }],
    };
  } catch (e) {
    if (e instanceof ExportTooLarge) return failed('too_large', e.message);
    throw e;
  }
}

/**
 * A business's data as its starter reads it: JSON and CSV per entity and export source, in one
 * zip archive kept on the job. No outside service: `submit` does the work.
 */
export const DataExportJob = defineJob<ExportJobInput, ExportOutput>({
  name: DATA_EXPORT_JOB,
  description:
    "Exports the business's records its starter can read, as JSON and CSV files in one zip archive.",
  input: ExportJobInput,
  output: ExportOutput,
  timeoutMs: 60 * 60_000,
  submitTimeoutMs: 55 * 60_000,
  submitAttempts: 2,
  callback: false,
  maxFiles: 1,
  submit: runExport,
});
