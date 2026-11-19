import { ApprovalService, UndoService } from '@hykr/core';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineFeature } from '../feature.js';

/**
 * The approvals sweeper's work, once a minute: requests nobody decided in time become
 * `expired` (audited as the system, `approval.decided` stored and published, so a customer who
 * asked hears it), and undo windows closed for a day are forgotten.
 */
export const ApprovalsExpireQueue = defineQueue<unknown, { expired: number; forgotten: number }>({
  name: 'approvals.expire',
  process: async (_job, ctx) => ({
    expired: await ctx.get(ApprovalService).expireDue(),
    forgotten: await ctx.get(UndoService).forgetClosed(),
  }),
});

export const ApprovalsExpireSchedule = defineSchedule({
  name: 'approvals.expire',
  queue: ApprovalsExpireQueue.name,
  every: 60_000,
});

/** Approvals that expire on their own, whether or not anyone opens them. */
export const approvalsFeature = defineFeature({
  name: 'approvals',
  contributes: { queues: [ApprovalsExpireQueue], schedules: [ApprovalsExpireSchedule] },
});
