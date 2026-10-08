import {
  type ChannelAdapter,
  type OutboundMessage,
  PermanentError,
  RetryableError,
} from '@app/channels';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { type Job, RateLimitError, UnrecoverableError } from 'bullmq';
import { config } from '../../config.js';
import { ContactsService } from '../contacts.service.js';
import { DeliveryFailed } from '../events.js';
import { OutboundService, type SendJob } from '../outbound.service.js';
import { QUEUES } from '../queues.js';
import { WHATSAPP } from './adapter.provider.js';

const log = new Logger('WhatsAppSend');

/**
 * Sends one contact's messages, in order, at the number's rate. Progress is saved after each
 * message, so a retry resumes where it stopped rather than sending twice. Rate limits and the
 * provider's own errors are retried (5 attempts, backing off); anything permanent is not, and
 * the rest of the batch is marked failed with it.
 */
@Processor(QUEUES.send, {
  concurrency: 5,
  limiter: { max: config.whatsapp.sendRatePerSec, duration: 1000 },
})
export class SendProcessor extends WorkerHost {
  constructor(
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    private readonly outbound: OutboundService,
    private readonly contacts: ContactsService,
    @Inject(EventBus) private readonly events: EventBus,
  ) {
    super();
  }

  async process(job: Job<SendJob>) {
    const data = job.data;
    for (let i = data.cursor; i < data.messageIds.length; i++) {
      const row = await this.outbound.load(data.messageIds[i]);
      if (row?.status !== 'queued') continue;
      const msg = row.body as OutboundMessage;
      // Free-form text only inside the 24-hour window; outside it, templates only.
      if (
        msg.kind !== 'template' &&
        (!data.contactId || !(await this.contacts.windowOpen(data.contactId)))
      ) {
        await this.failRest(data, i, 131047, 'outside the 24-hour window');
        throw new UnrecoverableError('outside the 24-hour window');
      }
      try {
        const { providerMessageId } = await this.wa.send(data.from, msg);
        await this.outbound.markSent(row.id, providerMessageId);
        for (const s of await this.outbound.pendingStatuses(providerMessageId))
          await this.outbound.applyStatus(s);
      } catch (e) {
        if (e instanceof RetryableError) {
          if (e.retryAfterMs) {
            await this.worker.rateLimit(e.retryAfterMs);
            throw new RateLimitError();
          }
          throw e;
        }
        if (e instanceof PermanentError) {
          await this.failRest(data, i, e.code, e.message);
          throw new UnrecoverableError(e.message);
        }
        throw e;
      }
      await job.updateData({ ...data, cursor: i + 1 });
    }
  }

  /** This message and the ones after it: failed, and their notifications move on. */
  private async failRest(data: SendJob, from: number, code: number | undefined, why: string) {
    log.warn(`send to contact ${data.contactId} failed (${code ?? '?'}): ${why}`);
    for (const id of data.messageIds.slice(from)) {
      const row = await this.outbound.load(id);
      if (row?.status !== 'queued') continue;
      await this.outbound.markFailed(id, code);
      if (data.contactId)
        this.events.publish(new DeliveryFailed(id, data.contactId, code, row.notification));
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendJob> | undefined, error: Error) {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
      log.error(`gave up sending to contact ${job.data.contactId}: ${error.message}`);
  }
}
