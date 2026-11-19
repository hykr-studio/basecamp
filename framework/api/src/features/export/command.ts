// POST /api/exports: start an export of the business's data, through the write path like any
// other write (validated, idempotent, authorized by `data.export`, audited).
import { DATA_EXPORT_JOB, DataExportCapability, StartExportSpec } from '@hykr/contracts';
import { allow, defineCommand, deny, tenantOf } from '@hykr/core';
import { jobs } from '@hykr/db';
import { can } from '@hykr/policy';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { presentJob } from '../jobs/info.js';
import { startJob } from '../jobs/start.js';
import { unknownParts } from './build.js';
import { DataExportJob } from './job.js';

/** Both formats, unless the person picked. */
const ALL_FORMATS = ['json', 'csv'] as const;

export const StartExport = defineCommand(StartExportSpec, {
  resource: { type: 'tenant', id: (_input, loaded: { tenantId: string }) => loaded.tenantId },
  load: async (_tx, p) => ({ tenantId: tenantOf(p) }),
  authorize: (p) =>
    can(p, DataExportCapability)
      ? allow('data_exporter')
      : deny('needs_data_export', "Only someone who may export the business's data can do this"),
  summarize: () => "Export the business's data",
  run: async ({ tx, principal, input, loaded: { tenantId } }) => {
    const only = input.only ? [...new Set(input.only)] : undefined;
    const unknown = unknownParts(only);
    if (unknown.length)
      throw new BadRequestException({
        error: 'unknown_export_part',
        message: `Nothing to export is called ${unknown.map((n) => `"${n}"`).join(', ')}`,
      });
    // One export of a business at a time: two starts at once wait for each other here.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`export:${tenantId}`}))`);
    const [running] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.kind, DATA_EXPORT_JOB),
          inArray(jobs.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (running)
      throw new ConflictException({
        error: 'export_running',
        message: 'An export of this business is still running: wait for it to finish',
      });
    const job = await startJob(tx, principal, DataExportJob, {
      formats: [...new Set(input.formats ?? ALL_FORMATS)],
      ...(only ? { only } : {}),
    });
    return { value: job, touched: [] };
  },
  present: (job, p) => presentJob(job, p),
});
