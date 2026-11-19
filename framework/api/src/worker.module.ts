import { Module } from '@nestjs/common';
import { ChannelsModule } from './channels/channels.module.js';
import { FeaturesModule } from './features/features.module.js';
import { coreImports } from './infra/core-imports.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { QueuesModule } from './queues/queues.module.js';

/**
 * The queue worker: the same framework, application and chat service as the API, with every
 * queue's processors (the channel's, the features', the application's) and no HTTP server. The
 * agent's tools still call the API over HTTP (API_INTERNAL_URL), so the API must be running too.
 */
@Module({
  imports: [
    ...coreImports(),
    QueuesModule.forRoot({ processors: true }),
    FeaturesModule.forRoot({ http: false, processors: true }),
    ChatModule,
    ChannelsModule.forRoot({ processors: true }),
  ],
})
export class WorkerModule {}
