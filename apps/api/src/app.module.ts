import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { ZodValidationPipe } from 'nestjs-zod';
import { ChannelsModule } from './channels/channels.module.js';
import { config } from './config.js';
import { HealthController } from './health/health.controller.js';
import { auth } from './infra/auth.js';
import { coreImports } from './infra/core-imports.js';
import { CallerThrottlerGuard } from './infra/throttle.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { HistoryController } from './modules/history/history.controller.js';
import { MeModule } from './modules/me/me.controller.js';
import { VoiceModule } from './modules/voice/voice.module.js';

@Module({
  imports: [
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
    // The framework (CQRS, principals, approvals), the domain, and saved pages: shared with
    // the queue worker.
    ...coreImports,
    // The channel's queues: this process adds jobs; the worker runs them (or this one, inline).
    ChannelsModule.forRoot({ processors: config.workerInline }),
    // The assistant, in the app and on WhatsApp.
    ChatModule,
    VoiceModule,
    MeModule,
  ],
  controllers: [HealthController, HistoryController],
  providers: [
    { provide: APP_GUARD, useClass: CallerThrottlerGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
