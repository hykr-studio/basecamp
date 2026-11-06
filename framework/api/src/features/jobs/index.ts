import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { jobDefs } from './define.js';
import { jobFiles } from './holder.js';
import { JobCallbackController, JobsController } from './jobs.controller.js';
import { jobLive } from './live.js';
import { jobsErasure, jobsExport } from './privacy.js';
import './routes.js';
import {
  APPLY_QUEUE,
  CANCEL_QUEUE,
  COMPLETE_ATTEMPTS,
  JobRunner,
  SUBMIT_QUEUE,
  submitJobId,
} from './runner.service.js';
import { jobsTools } from './tools.js';

/** Hands queued jobs to their services. */
export const JobsSubmitQueue = defineQueue<{ jobId: string }, string>({
  name: SUBMIT_QUEUE,
  concurrency: 5,
  process: (job, ctx) => ctx.get(JobRunner).submit(job.data.jobId),
});

/** Applies stored updates; a download that fails is tried again. */
export const JobsApplyQueue = defineQueue<{ updateId: string }, string>({
  name: APPLY_QUEUE,
  concurrency: 5,
  attempts: 3,
  backoffMs: 2_000,
  process: (job, ctx) =>
    ctx
      .get(JobRunner)
      .applyStored(job.data.updateId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
});

/** Tells a service to stop a cancelled or timed-out job. */
export const JobsCancelQueue = defineQueue<{ jobId: string }, string>({
  name: CANCEL_QUEUE,
  attempts: 3,
  backoffMs: 5_000,
  process: (job, ctx) => ctx.get(JobRunner).stop(job.data.jobId),
});

/** Deadlines, polls and recovery. */
export const JobsTickQueue = defineQueue({
  name: 'jobs.tick',
  process: (_job, ctx) => ctx.get(JobRunner).tick(),
});

/** Every ten seconds. */
export const JobsTickSchedule = defineSchedule({
  name: 'jobs.tick',
  queue: JobsTickQueue.name,
  every: 10_000,
});

/** A job is queued (its write committed): hand it over. */
export const JobsOnQueued = defineSubscriber({
  name: 'jobs.on-queued',
  on: ['job.queued'],
  handle: async (event, ctx) => {
    if (!event.resourceId) return;
    await ctx.jobs.add(
      SUBMIT_QUEUE,
      { jobId: event.resourceId },
      { jobId: submitJobId(event.resourceId, 0) },
    );
  },
});

/** A job succeeded: its kind's `complete` writes the results back. */
export const JobsOnSucceeded = defineSubscriber({
  name: 'jobs.on-succeeded',
  on: ['job.succeeded'],
  when: (event) => !!jobDefs.get(String((event.row as { kind?: unknown } | null)?.kind))?.complete,
  attempts: COMPLETE_ATTEMPTS,
  backoffMs: 2_000,
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(JobRunner).complete(event.resourceId);
  },
});

/**
 * Long-running jobs (docs/decisions/B11.md): kinds declared with `defineJob`, started inside a
 * write (`startJob`), submitted by the worker, followed through signed callbacks or polling,
 * finished with an output and result files kept on the job, written back by `complete`. Its
 * events reach the live stream of whoever reaches the job.
 */
export const jobsFeature = defineFeature({
  name: 'jobs',
  controllers: [JobsController, JobCallbackController],
  providers: [JobRunner],
  exports: [JobRunner],
  contributes: {
    queues: [JobsSubmitQueue, JobsApplyQueue, JobsCancelQueue, JobsTickQueue],
    schedules: [JobsTickSchedule],
    subscribers: [JobsOnQueued, JobsOnSucceeded],
    fileHolders: [jobFiles],
    liveResources: [jobLive],
    toolContributions: [jobsTools],
    erasureContributors: [jobsErasure],
    exportContributors: [jobsExport],
  },
});
