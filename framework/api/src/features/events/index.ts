import { DomainEventEnvelope } from '@hykr/contracts';
import { subscribers } from '../../hooks.js';
import { defineQueue } from '../../queues/define.js';
import { defineFeature } from '../feature.js';
import { outboxFeed } from './outbox-feed.js';
import { EventFeedPoller, EventRelay } from './relay.service.js';
import { EVENTS_QUEUE } from './subscriber.js';

/**
 * The shared queue of subscribers with `handle`. The job's name is the subscriber's; one that
 * is gone since (a deploy removed it) is skipped.
 */
export const EventsQueue = defineQueue<DomainEventEnvelope, string | undefined>({
  name: EVENTS_QUEUE,
  concurrency: 10,
  process: async (job, ctx) => {
    const s = subscribers.get(job.name);
    if (!s?.handle) return 'no such subscriber';
    await s.handle(DomainEventEnvelope.parse(job.data), ctx);
  },
});

/** Stored events → subscribers' queues: the outbox feed, the worker's poller, the relay. */
export const eventsFeature = defineFeature({
  name: 'events',
  providers: [EventRelay],
  processors: [EventFeedPoller],
  exports: [EventRelay],
  contributes: { queues: [EventsQueue], eventFeeds: [outboxFeed] },
});
