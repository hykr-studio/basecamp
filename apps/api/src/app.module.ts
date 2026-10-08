import { AGENT_ID } from '@app/agents';
import { VOICE_AGENT_ID } from '@app/contracts';
import { CoreModule } from '@app/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { ZodValidationPipe } from 'nestjs-zod';
import { config } from './config.js';
import { DomainModule } from './domain/index.js';
import { HealthController } from './health/health.controller.js';
import { auth } from './infra/auth.js';
import { sharedDb } from './infra/db.js';
import { DbModule } from './infra/db.module.js';
import { CallerThrottlerGuard } from './infra/throttle.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { HistoryController } from './modules/history/history.controller.js';
import { PagesModule } from './modules/pages/pages.module.js';
import { VoiceModule } from './modules/voice/voice.module.js';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module.js';

@Module({
  imports: [
    DbModule,
    // Registers a global guard: every route needs a session unless marked
    // @AllowAnonymous() or @OptionalAuth(). CORS is set once, in main.ts.
    AuthModule.forRoot({
      auth,
      disableTrustedOriginsCors: true,
      // Webhooks are verified by an HMAC over the exact bytes received.
      bodyParser: { rawBody: true },
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      // The e2e suite turns it off (THROTTLE=off) so back-to-back runs don't trip it.
      skipIf: () => process.env.THROTTLE === 'off',
      storage: new ThrottlerStorageRedisService(config.redisUrl), // shared across processes
    }),
    // The framework: CQRS buses, principal guards, approvals (park and replay).
    CqrsModule.forRoot(),
    CoreModule.forRoot({
      db: sharedDb.db,
      agents: [
        // The assistant: acts through tools; forwards the turn's channel.
        { id: AGENT_ID, key: config.agentApiKey },
        // The voice worker: a relay that starts turns for the person it acts for.
        { id: VOICE_AGENT_ID, key: config.voiceAgentKey, relay: true, channel: 'voice' },
      ],
    }),
    // Business modules: declarations only.
    // The domain (src/domain): its entities and commands.
    DomainModule,
    // The framework's own entities: saved canvas pages.
    PagesModule,
    // The assistant, in the app and on WhatsApp.
    ChatModule,
    WhatsappModule,
    VoiceModule,
  ],
  controllers: [HealthController, HistoryController],
  providers: [
    { provide: APP_GUARD, useClass: CallerThrottlerGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
