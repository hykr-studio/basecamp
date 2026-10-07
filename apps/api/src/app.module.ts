import { AGENT_ID } from '@app/agents';
import { CoreModule } from '@app/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { ZodValidationPipe } from 'nestjs-zod';
import { config } from './config.js';
import { HealthController } from './health/health.controller.js';
import { auth } from './infra/auth.js';
import { sharedDb } from './infra/db.js';
import { DbModule } from './infra/db.module.js';
import { ChatController } from './modules/chat/chat.controller.js';
import { MeetingsModule } from './modules/meetings/meetings.module.js';
import { NotesModule } from './modules/notes/notes.module.js';
import { TodosModule } from './modules/todos/todos.module.js';

@Module({
  imports: [
    DbModule,
    // Registers a global guard: every route needs a session unless marked
    // @AllowAnonymous() or @OptionalAuth(). CORS is set once, in main.ts.
    AuthModule.forRoot({ auth, disableTrustedOriginsCors: true }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      storage: new ThrottlerStorageRedisService(config.redisUrl), // shared across processes
    }),
    // The framework: CQRS buses, principal guards, approvals (park and replay).
    CqrsModule.forRoot(),
    CoreModule.forRoot({ db: sharedDb.db, agentApiKey: config.agentApiKey, agentId: AGENT_ID }),
    // Business modules: declarations only.
    TodosModule,
    NotesModule,
    MeetingsModule,
  ],
  controllers: [HealthController, ChatController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
