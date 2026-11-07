// Personal data (B18, docs/decisions/B18.md): requests to export or erase what a business holds
// about a person, with a deadline; the data principal service that carries them out over every
// contributor, the framework's tables, the declared entities and Mastra's schemas, with audit
// redaction; the retention runner; and the register of processors and personal data.
import { type DomainEventEnvelope, PRIVACY_REQUEST, reserveRoutes } from '@hykr/contracts';
import { commandController, commandHandler } from '@hykr/core';
import { privacyRequests } from '@hykr/db';
import { and, eq } from 'drizzle-orm';
import { channelErasure, PRIVACY_INTAKE } from '../../channels/maintenance/erasure.js';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import type { FileHolder } from '../files/holders.js';
import type { LiveResource } from '../live/resources.js';
import { privacyCommands } from './commands.js';
import { PrivacyController } from './privacy.controller.js';
import { ARCHIVE_FIELD, PrivacyService } from './privacy.service.js';
import { reachesRequest } from './requests.js';
import { frameworkTargets } from './targets.js';

// /api/privacy/* is the framework's.
reserveRoutes('privacy');

/** Carries out a request once its write committed (`privacy.request.started`). */
export const PrivacyRequestsQueue = defineQueue<DomainEventEnvelope>({
  name: 'privacy.requests',
  attempts: 3,
  backoffMs: 5000,
  process: (job, ctx) =>
    ctx
      .get(PrivacyService)
      .runQueued(String(job.data.resourceId), job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
});

export const PrivacyRunner = defineSubscriber({
  name: 'privacy.run',
  on: ['privacy.request.started'],
  queue: PrivacyRequestsQueue.name,
  attempts: 3,
});

/** Marks open requests past their deadline. */
export const PrivacyOverdueQueue = defineQueue({
  name: 'privacy.overdue',
  process: (_job, ctx) => ctx.get(PrivacyService).sweepOverdue(),
});

/** Every five minutes. */
export const PrivacyOverdueSchedule = defineSchedule({
  name: 'privacy.overdue',
  queue: PrivacyOverdueQueue.name,
  every: 5 * 60_000,
});

/** Applies the retention rules. */
export const PrivacyRetentionQueue = defineQueue({
  name: 'privacy.retention',
  process: (_job, ctx) => ctx.get(PrivacyService).runRetention(),
});

/** Once a day. */
export const PrivacyRetentionSchedule = defineSchedule({
  name: 'privacy.retention',
  queue: PrivacyRetentionQueue.name,
  every: 24 * 60 * 60_000,
});

/** An export archive is kept on its request: whoever reads the request reaches it. */
export const PrivacyArchives: FileHolder = {
  type: PRIVACY_REQUEST,
  async reaches({ p, resourceId, field, fileId, db }) {
    if (field !== ARCHIVE_FIELD || !p.tenantId) return false;
    const [row] = await db
      .select()
      .from(privacyRequests)
      .where(and(eq(privacyRequests.id, resourceId), eq(privacyRequests.tenantId, p.tenantId)));
    return !!row && reachesRequest(p, row) && row.files.includes(fileId);
  },
};

/** A request's changes reach its person and the privacy team, live. */
export const PrivacyLive: LiveResource = {
  type: PRIVACY_REQUEST,
  async visible(p, id, ctx) {
    if (!p.tenantId) return false;
    const [row] = await ctx.db
      .select()
      .from(privacyRequests)
      .where(and(eq(privacyRequests.id, id), eq(privacyRequests.tenantId, p.tenantId)));
    return !!row && reachesRequest(p, row);
  },
};

export const privacyFeature = defineFeature({
  name: 'privacy',
  controllers: [PrivacyController, ...privacyCommands.map((c) => commandController(c))],
  providers: [
    PrivacyService,
    { provide: PRIVACY_INTAKE, useExisting: PrivacyService },
    ...privacyCommands.map((c) => commandHandler(c)),
  ],
  exports: [PrivacyService, PRIVACY_INTAKE],
  contributes: {
    erasureContributors: [channelErasure],
    retentionTargets: frameworkTargets,
    queues: [PrivacyRequestsQueue, PrivacyOverdueQueue, PrivacyRetentionQueue],
    schedules: [PrivacyOverdueSchedule, PrivacyRetentionSchedule],
    subscribers: [PrivacyRunner],
    fileHolders: [PrivacyArchives],
    liveResources: [PrivacyLive],
  },
});
