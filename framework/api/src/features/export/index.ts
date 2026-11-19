// Exporting a business's data (A11X, docs/decisions/A11X.md): `POST /api/exports` starts a job
// that reads every entity and export source as the person who asked and keeps one zip archive of
// JSON and CSV files on the job.
import { reserveRoutes } from '@hykr/contracts';
import { commandController, commandHandler } from '@hykr/core';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { defineFeature } from '../feature.js';
import { StartExport } from './command.js';
import { DataExportJob } from './job.js';
import { exportResults } from './results.js';
import { exportSourceProblems } from './sources.js';

// POST /api/exports is the framework's.
reserveRoutes('exports');

/** A source whose name is bad or taken stops the start: its files would overwrite another's. */
@Injectable()
class ExportSourcesCheck implements OnApplicationBootstrap {
  onApplicationBootstrap() {
    const problems = exportSourceProblems();
    if (problems.length) throw new Error(`Data export sources:\n- ${problems.join('\n- ')}`);
  }
}

export const exportFeature = defineFeature({
  name: 'export',
  controllers: [commandController(StartExport)],
  providers: [commandHandler(StartExport), ExportSourcesCheck],
  contributes: {
    jobs: [DataExportJob],
    readProjectors: [exportResults],
  },
});
