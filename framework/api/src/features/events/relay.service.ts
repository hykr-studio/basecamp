import { DomainEventEnvelope } from '@hykr/contracts';
import { isNamedEvent } from '@hykr/core';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { config } from '../../config.js';
import { eventFeeds, type ServerContext, subscribers } from '../../hooks.js';
import { JobsService, serverContext } from '../../queues/jobs.service.js';
import { envelopeOf } from './envelope.js';
import { checkSubscribers, EVENTS_QUEUE, subscriberJobId, wants } from './subscriber.js';

const log = new Logger('Events');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Puts each committed event on the queue of every subscriber that wants it: the shared `events`
 * queue for a subscriber with `handle`, its own queue otherwise. The job id is
 * `<subscriber>--<event id>`, so an event relayed twice (a crash between adding and marking it)
 * runs once. An event not yet available (a tier 1 undo window) waits until then.
 */
@Injectable()
export class EventRelay implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  /** Every subscriber's queue exists: checked once everything has registered. */
  onApplicationBootstrap() {
    checkSubscribers();
  }

  async publish(events: readonly DomainEventEnvelope[]) {
    for (const raw of events) {
      const event = DomainEventEnvelope.parse(raw);
      const delay = event.availableAt ? Math.max(0, Date.parse(event.availableAt) - Date.now()) : 0;
      for (const s of subscribers.all()) {
        if (!wants(s, event)) continue;
        await this.jobs.add(s.queue ?? EVENTS_QUEUE, event, {
          name: s.name,
          jobId: subscriberJobId(s.name, event.id),
          delay,
          attempts: s.attempts ?? 3,
          backoff: { type: 'exponential', delay: s.backoffMs ?? 2000 },
        });
      }
    }
  }
}

/**
 * Until a durable feed is registered, events published on the in-process bus after commit are
 * relayed from here, in whichever process wrote them (the API, or the worker for an approval
 * replay). It steps aside as soon as a feed exists, so no event is relayed twice.
 */
@Injectable()
export class EventBusBridge implements OnModuleInit {
  constructor(
    @Inject(EventBus) private readonly bus: EventBus,
    private readonly relay: EventRelay,
  ) {}

  onModuleInit() {
    this.bus.subscribe((e) => {
      if (eventFeeds.all().length || !isNamedEvent(e) || !subscribers.all().length) return;
      const envelope = envelopeOf(e);
      if (!envelope) {
        log.warn(`${e.eventName}: the row has no tenantId, so no subscriber gets it`);
        return;
      }
      this.relay
        .publish([envelope])
        .catch((err) => log.error(`relaying ${e.eventName} failed: ${message(err)}`));
    });
  }
}

const EVERY_MS = 1000;
const BATCH = 100;

/**
 * The worker's poller: each second, each feed's pending events for this queue prefix go to the
 * relay, then are marked relayed. One tick at a time. Feeds get the services (`ctx.db`).
 */
@Injectable()
export class EventFeedPoller implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly ctx: ServerContext;

  constructor(
    private readonly relay: EventRelay,
    @Inject(ModuleRef) ref: ModuleRef,
  ) {
    this.ctx = serverContext(ref);
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const prefix = config.queuePrefix;
    try {
      for (const feed of eventFeeds.all()) {
        try {
          const events = await feed.pending({ limit: BATCH, prefix }, this.ctx);
          if (!events.length) continue;
          await this.relay.publish(events);
          await feed.relayed(
            events.map((e) => e.id),
            { prefix },
            this.ctx,
          );
        } catch (e) {
          log.error(`feed ${feed.name}: ${message(e)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
