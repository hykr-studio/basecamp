import { type Database, schema } from '@app/db';
import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { QUEUES } from '../queues.js';
import type { DispatchJob } from './notify.service.js';

const log = new Logger('Outbox');
const EVERY_MS = 1000;

/**
 * Moves committed outbox rows to notify-dispatch. A row exists only if its transaction
 * committed; the job id is the row's, so moving it twice (a crash between add and mark) adds it
 * once.
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
      const rows = await this.db
        .select()
        .from(schema.outbox)
        // Only this process's queues' rows: a dev worker and a test run can share a database.
        .where(
          and(
            isNull(schema.outbox.relayedAt),
            sql`coalesce(${schema.outbox.payload}->>'queues', 'bull') = ${config.queuePrefix}`,
          ),
        )
        .orderBy(asc(schema.outbox.id))
        .limit(100);
      if (!rows.length) return;
      for (const r of rows) {
        const payload = r.payload as Pick<DispatchJob, 'row' | 'dedupe'>;
        await this.dispatch.add(
          'now',
          { key: r.key, tenantId: r.tenantId, row: payload.row, dedupe: payload.dedupe },
          { jobId: `outbox-${r.id}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
      }
      await this.db
        .update(schema.outbox)
        .set({ relayedAt: new Date() })
        .where(
          inArray(
            schema.outbox.id,
            rows.map((r) => r.id),
          ),
        );
    } catch (e) {
      log.error(`relay failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running = false;
    }
  }
}
