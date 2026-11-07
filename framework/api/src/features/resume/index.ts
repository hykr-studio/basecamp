// Durable runs (A7): an assistant run that waits for an approval goes on once it is decided.
// The tool side (suspend on a parked write, answer a resume with the decision) is in
// @hykr/core/tools; the agent side (a suspended turn reads as a parked one, finding and resuming
// a run) in @hykr/agents. docs/decisions/A7.md.
import { DomainEventEnvelope } from '@hykr/contracts';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
// The live registry first: installing `liveResources` needs its collector.
import '../live/resources.js';
import { ThreadsModule } from '../../modules/threads/threads.module.js';
import { ThreadsService, threadOwnerOf } from '../../modules/threads/threads.service.js';
import { defineQueue } from '../../queues/define.js';
import type { LiveResource } from '../live/resources.js';
import { ResumeService } from './resume.service.js';

const DECIDED = new Set(['approved', 'rejected', 'expired', 'failed']);

/** One decided request an assistant's run may wait for: resumed one at a time per run. */
export const AgentResumeQueue = defineQueue<DomainEventEnvelope, string>({
  name: 'agent-resume',
  concurrency: 4,
  attempts: 4,
  backoffMs: 1000,
  process: (job, ctx) => ctx.get(ResumeService).onDecided(DomainEventEnvelope.parse(job.data)),
});

/**
 * Every decision (in the app, on WhatsApp, or the expiry sweeper) of a request an agent made in a
 * run. Requests a person made themselves, or without a run, resume nothing.
 */
export const ResumeOnDecision = defineSubscriber({
  name: 'resume.approvals',
  on: ['approval.decided'],
  when: (e) => {
    const row = e.row as { runId?: unknown; requestedBy?: unknown; status?: unknown } | null;
    return (
      typeof row?.runId === 'string' &&
      row.requestedBy === 'agent' &&
      DECIDED.has(String(row.status))
    );
  },
  queue: AgentResumeQueue.name,
  attempts: 4,
  backoffMs: 1000,
});

/** A thread's live events (a run went on in it) reach its owner only. */
export const ThreadLive: LiveResource = {
  type: 'thread',
  visible: async (p, id, ctx) => {
    await ctx.get(ThreadsService).owned(id, threadOwnerOf(p));
    return true;
  },
};

export const resumeFeature = defineFeature({
  name: 'resume',
  imports: [ThreadsModule],
  providers: [ResumeService],
  exports: [ResumeService],
  contributes: {
    queues: [AgentResumeQueue],
    subscribers: [ResumeOnDecision],
    liveResources: [ThreadLive],
  },
});
