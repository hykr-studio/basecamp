import { Module } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { ZodValidationPipe } from 'nestjs-zod';
import { ChannelsModule } from './channels/channels.module.js';
import { config } from './config.js';
import { FeaturesModule } from './features/features.module.js';
import { installFeatures } from './features/install.js';
import { HealthController } from './health/health.controller.js';
import { authMiddleware, getAuth } from './infra/auth.js';
import { coreImports } from './infra/core-imports.js';
import { CallerThrottlerGuard, throttleStorage } from './infra/throttle.js';
import { UntrustedTextGuard } from './infra/untrusted-text.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { HistoryController } from './modules/history/history.controller.js';
import { MeModule } from './modules/me/me.controller.js';
import { VoiceModule } from './modules/voice/voice.module.js';
import { QueuesModule } from './queues/queues.module.js';

/**
 * Better Auth for the API, built once the application is registered and the framework features'
 * contributions are installed: their auth plugins (the MCP authorization server, custom domains)
 * are then in. FeaturesModule installs them too, but after this runs.
 */
function authWithFeatures() {
  installFeatures();
  return getAuth();
}

@Module({
  imports: [
    // Registers a global guard: every route needs a session unless marked
    // @AllowAnonymous() or @OptionalAuth(). CORS is set once, in main.ts.
    // Better Auth is built here, once the application (and its auth plugins) is registered.
    AuthModule.forRoot({
      auth: authWithFeatures(),
      disableTrustedOriginsCors: true,
      // The API's channel rules on Better Auth's routes, which no Nest guard sees.
      middleware: authMiddleware,
      // Webhooks are verified by an HMAC over the exact bytes received. JSON bodies up to
      // JSON_BODY_LIMIT (1mb): a whole order of a few hundred lines in one request.
      bodyParser: { rawBody: true, json: { limit: config.jsonBodyLimit } },
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      // The e2e suite turns it off (THROTTLE=off) so back-to-back runs don't trip it.
      skipIf: () => process.env.THROTTLE === 'off',
      storage: throttleStorage(), // shared across processes, and with Better Auth's limits
    }),
    // The framework (CQRS, principals, approvals), the domain, and saved pages: shared with
    // the queue worker.
    ...coreImports(),
    // Every registered queue: this process adds jobs; the worker runs them (or this one, inline).
    QueuesModule.forRoot({ processors: config.workerInline }),
    // The framework's features (features/index.ts).
    FeaturesModule.forRoot({ http: true, processors: config.workerInline }),
    ChannelsModule.forRoot({ processors: config.workerInline }),
    // The assistant, in the app and on WhatsApp.
    ChatModule,
    VoiceModule,
    MeModule,
  ],
  controllers: [HealthController, HistoryController],
  providers: [
    { provide: APP_GUARD, useClass: CallerThrottlerGuard },
    // A NUL character anywhere in what a request sends is 400, before any handler reads it.
    { provide: APP_GUARD, useClass: UntrustedTextGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
