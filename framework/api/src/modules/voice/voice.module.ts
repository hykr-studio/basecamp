import { Module } from '@nestjs/common';
import { ThreadsModule } from '../threads/threads.module.js';
import { VoiceController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';
import { VoiceSessionGuard } from './voice-session.guard.js';

/** Voice: LiveKit sessions for people; the turns themselves go through /api/chat. */
@Module({
  imports: [ThreadsModule],
  controllers: [VoiceController],
  providers: [VoiceService, VoiceSessionGuard],
  exports: [VoiceService, VoiceSessionGuard],
})
export class VoiceModule {}
