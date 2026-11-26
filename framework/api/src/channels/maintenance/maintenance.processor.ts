import { type Database, schema, writeAudit } from '@hykr/db';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';
import { QUEUES } from '../queues.js';
import { ErasureService } from './erasure.service.js';

export type MaintenanceJob =
  | { kind: 'erase'; contactId: string }
  /** Retired: retention is the privacy feature's runner now (a scheduler left in Redis). */
  | { kind: 'retention' }
  | { kind: 'stale-handoffs' };

/** A handoff nobody has taken for this long is flagged to the business. */
const STALE_HOURS = 24;

/**
 * Housekeeping: erasing a contact's data ("delete my data", through the privacy feature) and
 * flagging forgotten handoffs. Raw webhook payloads are cleared by the privacy feature's
 * retention runner (`channel.inbound-payloads`), after the period the application declares.
 */
@Processor(QUEUES.maintenance)
export class MaintenanceProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly erasure: ErasureService,
    @InjectQueue(QUEUES.maintenance) private readonly queue: Queue<MaintenanceJob>,
  ) {
    super();
  }

  async onModuleInit() {
    // The old daily payload clearing is the privacy feature's retention runner now.
    await this.queue.removeJobScheduler('retention').catch(() => undefined);
    await this.queue.upsertJobScheduler(
      'stale-handoffs',
      { every: 60 * 60 * 1000 },
      { name: 'stale-handoffs', data: { kind: 'stale-handoffs' } },
    );
  }

  async process(job: Job<MaintenanceJob>) {
    if (job.data.kind === 'erase') return this.erasure.erase(job.data.contactId);
    if (job.data.kind === 'stale-handoffs') return this.flagStale();
  }

  /** Open for a day with nobody on it: flagged, so the inbox shows it first. */
  async flagStale() {
    const { handoffs } = schema;
    const flagged = await this.db
      .update(handoffs)
      .set({ flaggedAt: new Date() })
      .where(
        and(
          eq(handoffs.state, 'open'),
          isNull(handoffs.flaggedAt),
          lt(handoffs.openedAt, sql`now() - make_interval(hours => ${STALE_HOURS})`),
        ),
      )
      .returning();
    for (const h of flagged)
      await writeAudit(this.db, {
        action: 'handoff.flagged',
        resourceType: 'handoff',
        resourceId: h.id,
        actorKind: 'system',
        actorId: 'maintenance',
        tenantId: h.tenantId,
        reason: `Open ${STALE_HOURS} hours with nobody on it`,
      });
    return { flagged: flagged.length };
  }
}
