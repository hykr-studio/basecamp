import type { ChannelAdapter } from '@app/channels';
import type { Database } from '@app/db';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { QUEUES } from '../queues.js';
import { WHATSAPP } from '../whatsapp/adapter.provider.js';
import { TemplateSync } from './template-sync.js';

const log = new Logger('Templates');

/**
 * Every 10 minutes, what the provider says about our templates: an approval, a rejection and
 * why, a quality pause. Shows up without anyone running a command. (Creating them stays a
 * deliberate step: pnpm templates:sync.)
 */
@Processor(QUEUES.templates)
export class TemplatesProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    @InjectQueue(QUEUES.templates) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    await this.queue.upsertJobScheduler(
      'templates-status',
      { every: 10 * 60_000 },
      { name: 'status' },
    );
  }

  async process() {
    const report = await new TemplateSync(this.db, this.wa, config.appUrl).run({ create: false });
    for (const e of report.errors) log.error(e);
    const rejected = report.statuses.filter(
      (s) => s.status === 'REJECTED' || s.status === 'PAUSED',
    );
    for (const s of rejected)
      log.warn(`${s.template} is ${s.status.toLowerCase()}: ${s.reason ?? ''}`);
  }
}
