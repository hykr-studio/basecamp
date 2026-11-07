// Starting an import: the job kind, the command that starts one (POST /api/imports), and the
// upload target its file is uploaded for.
import {
  type Catalog,
  featureEnabled,
  IMPORT_MIME_TYPES,
  IMPORT_UPLOAD,
  ImportOptions,
  ImportResult,
  ImportsCapability,
  notImportable,
  type Principal,
  StartImportSpec,
} from '@hykr/contracts';
import { allow, defineCommand, deny, entityDef, type Tx } from '@hykr/core';
import { schema } from '@hykr/db';
import { can } from '@hykr/policy';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { runtime } from '../../runtime.js';
import type { FileTarget } from '../files/targets.js';
import { defineJob } from '../jobs/define.js';
import { presentJob } from '../jobs/info.js';
import { startJob } from '../jobs/start.js';
import { entityOff, offWhen } from '../settings/gates.js';
import { importsConfig } from './config.js';
import { Importer } from './importer.service.js';
import { fieldsOf } from './values.js';

/**
 * The work of an import, in the worker, as whoever started it (decisions B20): about no record,
 * so only its starter reaches the job and its error report.
 */
export const ImportJob = defineJob<ImportOptions, ImportResult>({
  name: 'imports.records',
  description: 'Imports records of one entity from a file, row by row, through the write path.',
  input: ImportOptions,
  output: ImportResult,
  inputFiles: (input) => [input.file],
  // The whole import runs in one submission: its time limit is the job's.
  get timeoutMs() {
    return importsConfig().timeoutMs;
  },
  get submitTimeoutMs() {
    return importsConfig().timeoutMs;
  },
  submitAttempts: 3,
  callback: false,
  submit: (ctx) => ctx.get(Importer).run(ctx),
});

const mayImport = (p: Principal) =>
  can(p, ImportsCapability)
    ? allow('imports.run')
    : deny('needs_imports_run', 'Only someone who may import records can do this');

/** `POST /api/files { for: IMPORT_UPLOAD }`: a file to import, by someone who may. */
export const importUpload: FileTarget = {
  type: IMPORT_UPLOAD.entity,
  field: IMPORT_UPLOAD.field,
  accept: IMPORT_MIME_TYPES,
  may: mayImport,
};

/** Is this entity switched off for the business (a feature flag)? Read in the write. */
async function switchedOff(tx: Tx, tenantId: string, entity: string, catalog: Catalog) {
  const [row] = await tx
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  const settings = row?.settings as { features?: Record<string, unknown> } | undefined;
  return entityOff(
    offWhen((key) => featureEnabled(settings, key)),
    catalog,
    entity,
  );
}

const unknownEntity = (name: string) =>
  new NotFoundException({ error: 'not_found', message: `No "${name}" records here` });

/**
 * Start an import (decisions B20, 3 and 4): people with `imports.run` who may create the
 * entity. The entity must be served, importable and on for the business; `columns` and `refs`
 * must name its fields. The job then reads the file in the worker.
 */
export const StartImport = defineCommand(StartImportSpec, {
  resource: { type: 'import', id: () => null },
  load: async (tx, p, input) => {
    const def = entityDef(input.entity);
    if (!def || !p.tenantId) throw unknownEntity(input.entity);
    const catalog = runtime().catalog;
    if (await switchedOff(tx, p.tenantId, def.name, catalog)) throw unknownEntity(input.entity);
    const why = notImportable(def.spec);
    if (why) throw new BadRequestException({ error: 'not_importable', message: why });
    const fields = fieldsOf(def.spec);
    for (const field of Object.values(input.columns ?? {}))
      if (field !== null && !fields.all.has(field))
        throw new BadRequestException({
          error: 'unknown_field',
          message: `A ${def.spec.label} has no field "${field}"`,
        });
    for (const [field, entity] of Object.entries(input.refs ?? {})) {
      if (!fields.all.has(field))
        throw new BadRequestException({
          error: 'unknown_field',
          message: `A ${def.spec.label} has no field "${field}"`,
        });
      const target = entityDef(entity);
      if (!target || (await switchedOff(tx, p.tenantId, target.name, catalog)))
        throw unknownEntity(entity);
    }
    return { entity: def.name, plural: def.plural };
  },
  authorize: (p, loaded) => {
    if (p.actor.kind !== 'user')
      return deny('people_only', 'Only people import records from files');
    const may = mayImport(p);
    if (may.decision === 'deny') return may;
    const def = entityDef(loaded.entity);
    // They must be able to create its records at all; each row is then decided on its own.
    const create = def?.decide(p, 'create', null, {});
    if (!def || create?.decision === 'deny')
      return create ?? deny('no_access', `You can't create ${loaded.plural}`);
    return allow('imports.run', `Imports ${loaded.plural}`);
  },
  summarize: (input, loaded) =>
    `${input.dryRun ? 'Check an import of' : 'Import'} ${loaded.plural} from a file (source ${input.source})`,
  run: async ({ tx, principal, input }) => ({
    value: await startJob(tx, principal, ImportJob, input),
    touched: [],
  }),
  present: (job, p) => presentJob(job, p),
});
