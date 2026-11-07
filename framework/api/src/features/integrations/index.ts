// The integration bus (decisions B10): signed outbound webhooks with retries and a delivery log,
// verified inbound webhooks handled as the business's system principal, and connections whose
// credentials are sealed with SECRETS_KEY. Transport (signing, sealing, the egress guard, the
// Connector interface) is @hykr/connectors'.
import { standardWebhooks } from '@hykr/connectors';
import type { ReadProjector } from '@hykr/core';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { IntegrationsCapability } from './capability.js';
import { DELIVER_QUEUE, DeliveriesService, type DeliverJob, SWEEP } from './deliveries.service.js';
import { INBOUND_QUEUE, type InboundJob, InboundService } from './inbound.service.js';
import { IntegrationsController, WebhooksController } from './integrations.controller.js';
import { IntegrationsService } from './manage.service.js';
import { webhookable } from './payload.js';

/** Each try of a delivery; the sweeper's job too. Retries are scheduled by the service. */
export const DeliverQueue = defineQueue<DeliverJob, string | number>({
  name: DELIVER_QUEUE,
  concurrency: 10,
  process: async (job, ctx) => {
    if (job.name !== SWEEP) return ctx.get(DeliveriesService).attempt(job.data);
    return (await ctx.get(DeliveriesService).sweep()) + (await ctx.get(InboundService).sweep());
  },
});

/** Each stored inbound event: its handlers, as the business's system principal. */
export const InboundQueue = defineQueue<InboundJob, string>({
  name: INBOUND_QUEUE,
  concurrency: 5,
  attempts: 3,
  backoffMs: 2000,
  process: (job, ctx) =>
    ctx
      .get(InboundService)
      .process(job.data.inboundId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
});

/** Every minute: deliveries and inbound events whose job was lost get one again. */
export const SweepSchedule = defineSchedule({ name: SWEEP, queue: DELIVER_QUEUE, every: 60_000 });

/** Committed events about entities → one delivery per matching endpoint. */
export const WebhookFanOut = defineSubscriber({
  name: 'integrations.webhooks',
  on: ['*'],
  when: (event) => webhookable(event.resourceType),
  handle: async (event, ctx) => {
    await ctx.get(DeliveriesService).fanOut(event);
  },
});

/** An approval card of an integrations op never shows a sealed value. */
export const SealedOffCards: ReadProjector = {
  name: 'integrations.sealed',
  project: (type, value) => {
    if (type !== 'approval' || !String(value.action ?? '').startsWith('integrations.'))
      return value;
    const input = value.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return value;
    const { sealed: _sealed, ...rest } = input as Record<string, unknown>;
    return { ...value, input: rest };
  },
};

export const integrationsFeature = defineFeature({
  name: 'integrations',
  controllers: [IntegrationsController, WebhooksController],
  providers: [IntegrationsService, DeliveriesService, InboundService],
  exports: [IntegrationsService, DeliveriesService, InboundService],
  contributes: {
    capabilities: [IntegrationsCapability],
    connectors: [standardWebhooks],
    queues: [DeliverQueue, InboundQueue],
    schedules: [SweepSchedule],
    subscribers: [WebhookFanOut],
    readProjectors: [SealedOffCards],
  },
});
