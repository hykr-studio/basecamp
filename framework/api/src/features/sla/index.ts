import { type SweepResult, slaHook } from '@hykr/core';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineFeature } from '../feature.js';
import { SlaController } from './sla.controller.js';
import { SlaService } from './sla.service.js';

/** Breaches the clocks that ran out and escalates them (SlaService.sweep). */
export const SlaSweepQueue = defineQueue<unknown, SweepResult>({
  name: 'sla.sweep',
  process: (_job, ctx) => ctx.get(SlaService).sweep(),
});

/** Every minute. */
export const SlaSweepSchedule = defineSchedule({
  name: 'sla.sweep',
  queue: SlaSweepQueue.name,
  every: 60_000,
});

/**
 * SLAs (docs/decisions/B6B4.md): the `sla` write hook starts and ends a record's clocks in the
 * write's own transaction (`app.sla_timers`), the sweeper breaches and escalates them, and
 * GET /api/sla reads them.
 */
export const slaFeature = defineFeature({
  name: 'sla',
  controllers: [SlaController],
  providers: [SlaService],
  exports: [SlaService],
  contributes: {
    writeHooks: [slaHook],
    queues: [SlaSweepQueue],
    schedules: [SlaSweepSchedule],
  },
});
