import { Module } from '@nestjs/common';
import { FeaturesModule } from './features/features.module.js';
import { coreImports } from './infra/core-imports.js';
import { QueuesModule } from './queues/queues.module.js';

/**
 * What a one-off command needs (`basecamp import`): the framework, the application's modules
 * and the features' services, with no HTTP server and no processors, so it never takes another
 * process's queue work. Jobs it adds are run by the worker.
 */
@Module({
  imports: [
    ...coreImports(),
    QueuesModule.forRoot({ processors: false }),
    FeaturesModule.forRoot({ http: false, processors: false }),
  ],
})
export class CliModule {}
