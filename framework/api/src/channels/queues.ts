import { BullModule } from '@nestjs/bullmq';
import { config } from '../config.js';

/**
 * The channel's queues. The API only adds jobs (a webhook must answer in milliseconds; the
 * agent takes seconds); the worker process runs them, with retries, delays and rate limits.
 */
export const QUEUES = {
  /** One stored inbound message (or a burst from one sender) → one agent turn. */
  inbound: 'wa-inbound',
  /** Messages to one contact, in order, at the number's send rate. */
  send: 'wa-send',
  /** A notification: who, which channel and template, consent and quiet hours. Delayable. */
  dispatch: 'notify-dispatch',
  /** Template status from Meta (or whaloc), every 10 minutes. */
  templates: 'templates-sync',
  /** Erasure, retention and stale handoffs. */
  maintenance: 'channel-maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Redis for jobs (the same Redis as the rate limiter), and every queue registered once. */
export const queueImports = [
  BullModule.forRoot({
    connection: { url: config.redisUrl },
    prefix: config.queuePrefix,
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
  }),
  BullModule.registerQueue(...Object.values(QUEUES).map((name) => ({ name }))),
];
