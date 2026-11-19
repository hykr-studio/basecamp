import { IfMatchInterceptor } from '@hykr/core';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineFeature } from '../feature.js';
import { IdempotencyService } from './idempotency.service.js';
import { OfflineStart } from './start.js';

export { IdempotencyService, idempotencyKeepDays } from './idempotency.service.js';

/** Forgets stored write replies past the retention. */
export const IdempotencyPurgeQueue = defineQueue<unknown, { deleted: number }>({
  name: 'idempotency.purge',
  process: (_job, ctx) => ctx.get(IdempotencyService).purge(),
});

/** Every hour. */
export const IdempotencyPurgeSchedule = defineSchedule({
  name: 'idempotency.purge',
  queue: IdempotencyPurgeQueue.name,
  every: 60 * 60 * 1000,
});

/**
 * Offline capture, server side (docs/decisions/B12.md): `If-Match` reaches only the routes that
 * check it (an entity's update and delete; anywhere else 400), the stored replies of idempotent
 * writes are forgotten after `IDEMPOTENCY_KEEP_DAYS`, and entities marked `offline` are checked
 * at start. Client-chosen ids, the version check and the per-key lock are in the write path.
 */
export const offlineFeature = defineFeature({
  name: 'offline',
  providers: [
    IdempotencyService,
    OfflineStart,
    { provide: APP_INTERCEPTOR, useClass: IfMatchInterceptor },
  ],
  exports: [IdempotencyService],
  contributes: { queues: [IdempotencyPurgeQueue], schedules: [IdempotencyPurgeSchedule] },
});
