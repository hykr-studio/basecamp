import { commandController, commandHandler } from '@hykr/core';
import { defineFeature } from '../feature.js';
import { Importer } from './importer.service.js';
import './routes.js';
import { ImportJob, importUpload, StartImport } from './start.js';

/**
 * Bulk import (docs/decisions/B20.md): a file of one entity's records (CSV, JSON or NDJSON),
 * started with `POST /api/imports` or `basecamp import`, run as a job (`imports.records`) in the
 * worker: each row through runWrite as the starter, each key's record kept for the next run,
 * and the rows that were not written in an error report kept on the job.
 */
export const importsFeature = defineFeature({
  name: 'imports',
  controllers: [commandController(StartImport)],
  providers: [Importer, commandHandler(StartImport)],
  exports: [Importer],
  contributes: {
    jobs: [ImportJob],
    fileTargets: [importUpload],
  },
});
