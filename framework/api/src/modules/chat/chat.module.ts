import { Module } from '@nestjs/common';
import { ThreadsModule } from '../threads/threads.module.js';
import { VoiceModule } from '../voice/voice.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

/** The assistant's turns: the app's stream and JSON endpoints, and the service channels share. */
@Module({
  imports: [ThreadsModule, VoiceModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
