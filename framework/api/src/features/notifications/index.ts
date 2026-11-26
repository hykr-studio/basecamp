// Notifications from stored events, and sends held for an undo window (decisions H1). The
// dispatcher itself is the channel's (channels/notify); this feature feeds it.
import { DomainEventEnvelope } from '@hykr/contracts';
import { NotifyService, namedByNotifications } from '../../channels/notify/notify.service.js';
import { defineQueue } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { HeldSends } from './held.js';

/**
 * Stored events a notification names, one at a time per worker, in the order they were stored:
 * a record's reschedules apply in order.
 */
export const NotifyEventsQueue = defineQueue<DomainEventEnvelope>({
  name: 'notify.events',
  attempts: 3,
  backoffMs: 2000,
  process: async (job, ctx) => {
    await ctx.get(NotifyService).onStored(DomainEventEnvelope.parse(job.data));
  },
});

/**
 * Every committed event some notification names (`send.on`, `schedule.on`, `schedule.cancelOn`).
 * An undoable write's events arrive only once its window closes; an undone one's never do.
 */
export const NotifyOnEvents = defineSubscriber({
  name: 'notify.events',
  on: ['*'],
  when: (e) => namedByNotifications(e.name),
  queue: NotifyEventsQueue.name,
});

export const notificationsFeature = defineFeature({
  name: 'notifications',
  contributes: {
    queues: [NotifyEventsQueue],
    subscribers: [NotifyOnEvents],
    writeHooks: [HeldSends],
  },
});
