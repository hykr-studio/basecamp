import { type Database, schema } from '@hykr/db';
import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, inArray, isNull, lte, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { QUEUES } from '../queues.js';
import type { DispatchJob } from './notify.service.js';

const log = new Logger('Outbox');
const EVERY_MS = 1000;

/**
 * Moves committed outbox rows to notify-dispatch. A row exists only if its transaction
 * committed; the job id is the row's, so moving it twice (a crash between add and mark) adds it
 * once. A row held for an undo window waits until it closes; one withdrawn by an undo never goes.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(QUEUES.dispatch) private readonly dispatch: Queue<DispatchJob>,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Locked while they move, so an undo waits for this tick and then finds them passed on
      // (too late), instead of withdrawing rows already on the queue.
      await this.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(schema.outbox)
          // Only this process's queues' rows: a dev worker and a test run can share a database.
          .where(
            and(
              isNull(schema.outbox.relayedAt),
              isNull(schema.outbox.cancelledAt),
              lte(schema.outbox.availableAt, sql`now()`),
              sql`coalesce(${schema.outbox.payload}->>'queues', 'bull') = ${config.queuePrefix}`,
            ),
          )
          .orderBy(asc(schema.outbox.id))
          .limit(100)
          .for('update', { skipLocked: true });
        if (!rows.length) return;
        for (const r of rows) {
          // A payload that is not an object (only SQL could store one) fails in its own job,
          // never this tick's whole batch.
          const payload = (r.payload ?? {}) as Pick<DispatchJob, 'row' | 'dedupe' | 'resourceType'>;
          await this.dispatch.add(
            'now',
            {
              key: r.key,
              tenantId: r.tenantId,
              row: payload.row,
              ...(payload.resourceType ? { resourceType: payload.resourceType } : {}),
              dedupe: payload.dedupe,
            },
            { jobId: `outbox-${r.id}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
          );
        }
        await tx
          .update(schema.outbox)
          .set({ relayedAt: new Date() })
          .where(
            inArray(
              schema.outbox.id,
              rows.map((r) => r.id),
            ),
          );
      });
    } catch (e) {
      log.error(`relay failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running = false;
    }
  }
}
