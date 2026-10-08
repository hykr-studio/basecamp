import { Module } from '@nestjs/common';
import { ChannelsModule } from './channels/channels.module.js';
import { coreImports } from './infra/core-imports.js';
import { ChatModule } from './modules/chat/chat.module.js';

/**
 * The queue worker: the same framework, domain and chat service as the API, with the channel's
 * processors and no HTTP server. The agent's tools still call the API over HTTP
 * (API_INTERNAL_URL), so the API must be running too.
 */
@Module({
  imports: [...coreImports, ChatModule, ChannelsModule.forRoot({ processors: true })],
})
export class WorkerModule {}
