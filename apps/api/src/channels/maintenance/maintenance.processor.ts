import { type Database, schema, writeAudit } from '@app/db';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';
import { QUEUES } from '../queues.js';
import { ErasureService } from './erasure.service.js';

export type MaintenanceJob =
  | { kind: 'erase'; contactId: string }
  | { kind: 'retention' }
  | { kind: 'stale-handoffs' };

/** Raw webhook payloads are kept for debugging and replay, for 30 days. */
const RETENTION_DAYS = 30;
/** A handoff nobody has taken for this long is flagged to the business. */
const STALE_HOURS = 24;

/** Housekeeping: erasing a contact's data, clearing old payloads, flagging forgotten handoffs. */
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
    await this.queue.upsertJobScheduler(
      'retention',
      { every: 24 * 60 * 60 * 1000 },
      { name: 'retention', data: { kind: 'retention' } },
    );
    await this.queue.upsertJobScheduler(
      'stale-handoffs',
      { every: 60 * 60 * 1000 },
      { name: 'stale-handoffs', data: { kind: 'stale-handoffs' } },
    );
  }

  async process(job: Job<MaintenanceJob>) {
    if (job.data.kind === 'erase') return this.erasure.erase(job.data.contactId);
    if (job.data.kind === 'stale-handoffs') return this.flagStale();
    await this.db
      .update(schema.inboundEvents)
      .set({ payload: null })
      .where(
        lt(schema.inboundEvents.receivedAt, sql`now() - make_interval(days => ${RETENTION_DAYS})`),
      );
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
