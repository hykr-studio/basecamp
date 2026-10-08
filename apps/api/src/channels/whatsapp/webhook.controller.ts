import type { ChannelAdapter, InboundMessage } from '@app/channels';
import { type Database, schema } from '@app/db';
import { InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { SkipThrottle } from '@nestjs/throttler';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { DeliveryFailed } from '../events.js';
import { OutboundService } from '../outbound.service.js';
import { QUEUES } from '../queues.js';
import { WHATSAPP } from './adapter.provider.js';

const { inboundEvents } = schema;
const log = new Logger('WhatsAppWebhook');

/** A wa-inbound job: one stored message (a burst from one sender is merged when it runs). */
export type InboundJob = { providerMessageId: string };

/** How long to wait for more messages from the same sender: people type in short bursts. */
export const BURST_MS = 1500;

/**
 * Meta's webhook (whaloc in development and CI). It does four cheap things and answers 200:
 * verify the signature, store each message once (its id is unique, so a redelivery is a
 * no-op), queue it, and apply delivery statuses. The agent runs in the worker, not here: Meta
 * retries webhooks that are slow.
 */
@Controller('webhooks/whatsapp')
@AllowAnonymous()
@SkipThrottle()
export class WhatsAppWebhookController {
  constructor(
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    @Inject(DB) private readonly db: Database,
    private readonly outbound: OutboundService,
    @InjectQueue(QUEUES.inbound) private readonly inbound: Queue<InboundJob>,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  /** The one-time subscription check: echo the challenge if the verify token matches. */
  @Get()
  challenge(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (
      mode !== 'subscribe' ||
      !config.whatsapp.verifyToken ||
      token !== config.whatsapp.verifyToken
    )
      throw new ForbiddenException('verify token mismatch');
    return challenge;
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    if (!req.rawBody || !this.wa.verify(req.rawBody, req.headers))
      throw new UnauthorizedException('bad signature');
    const { messages, statuses } = this.wa.parse(req.body);
    for (const m of messages) await this.store(m);
    for (const s of statuses) {
      const updated = await this.outbound.applyStatus(s);
      // Accepted, then failed (not on WhatsApp, blocked): the notification moves on.
      if (updated?.contactId && s.status === 'failed')
        this.events.publish(
          new DeliveryFailed(updated.id, updated.contactId, s.errorCode, updated.notification),
        );
    }
    return 'ok';
  }

  private async store(m: InboundMessage) {
    const [inserted] = await this.db
      .insert(inboundEvents)
      .values({
        providerMessageId: m.providerMessageId,
        phoneNumberId: m.to,
        from: m.from,
        payload: m,
      })
      .onConflictDoNothing()
      .returning({ id: inboundEvents.id });
    if (!inserted) {
      log.log(`duplicate delivery of ${m.providerMessageId}: ignored`);
      return;
    }
    await this.inbound.add(
      'message',
      { providerMessageId: m.providerMessageId },
      {
        jobId: m.providerMessageId,
        delay: BURST_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );
  }
}
