import { MemoryManage, MemoryRead, MemoryWrite, reserveRoutes } from '@hykr/contracts';
import { entityController, entityHandlers } from '@hykr/core';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { MemoryAccess } from './access.js';
import { backfillAll, IndexOnWrite, MemoryIndexer, rebuild } from './indexer.js';
import { Memory } from './memory.entity.js';
import { EraseMemory, ExportMemory } from './privacy.js';
import { RecallController } from './recall.controller.js';
import { RecallHook, RecallService } from './recall.service.js';
import { MemoryTools } from './tools.js';

// GET /api/memory/recall: no module may take the segment (the entity's own is `memories`).
reserveRoutes('memory');

/** Index records no write has touched yet: one business, or every one. */
export const BackfillQueue = defineQueue<{ tenantId?: string }, number>({
  name: 'memory.backfill',
  process: (job, ctx) => backfillAll(ctx.db, job.data?.tenantId),
});

/** Daily, so records written before the feature (or the trait) are found. */
export const BackfillSchedule = defineSchedule({
  name: 'memory.backfill',
  queue: BackfillQueue.name,
  cron: '17 3 * * *',
  data: {},
});

/** A business's embedding model may have changed: its vectors are made again. */
export const RebuildOnPolicy = defineSubscriber({
  name: 'memory.models',
  on: ['models.policy.changed'],
  handle: (event, ctx) => rebuild(ctx.db, event.tenantId),
});

/**
 * Memory and semantic recall: the business's memory (the `memory` entity), records of any
 * entity with the `memory` trait, and what each person said, recalled by meaning before every
 * chat turn and through `GET /api/memory/recall`, each memory re-checked for the reader.
 */
export const memoryFeature = defineFeature({
  name: 'memory',
  controllers: [entityController(Memory), RecallController],
  providers: [...entityHandlers(Memory), RecallService],
  processors: [MemoryIndexer],
  exports: [RecallService],
  contributes: {
    capabilities: [MemoryRead, MemoryWrite, MemoryManage],
    entityPlugins: [MemoryAccess],
    writeHooks: [IndexOnWrite],
    turnHooks: [RecallHook],
    toolContributions: [MemoryTools],
    queues: [BackfillQueue],
    schedules: [BackfillSchedule],
    subscribers: [RebuildOnPolicy],
    erasureContributors: [EraseMemory],
    exportContributors: [ExportMemory],
  },
});

export { anyRole, MemoryAccess } from './access.js';
export { backfillAll, IndexOnWrite, MemoryIndexer, rebuild } from './indexer.js';
export { Memory } from './memory.entity.js';
export { contextLine, parseAbout, RecallService } from './recall.service.js';
