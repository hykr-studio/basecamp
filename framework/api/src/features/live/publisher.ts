import type { DomainEventEnvelope } from '@hykr/contracts';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { config } from '../../config.js';
import { liveChannel, signalOf } from './signal.js';

/**
 * Publishes committed events, as ids, on their business's Redis channel. It runs where the
 * subscriber's jobs run (the worker), so an event written by any process reaches every API.
 */
@Injectable()
export class LivePublisher implements OnApplicationShutdown {
  private redis: Redis | undefined;

  async publish(event: DomainEventEnvelope) {
    const signal = signalOf(event);
    if (!signal) return;
    this.redis ??= new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    await this.redis.publish(
      liveChannel(config.queuePrefix, signal.tenantId),
      JSON.stringify(signal),
    );
  }

  async onApplicationShutdown() {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }
}
