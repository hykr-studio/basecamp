import { DomainEventEnvelope } from '@hykr/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { config } from '../../config.js';
import { eventFeeds, type ServerContext, type Subscriber, subscribers } from '../../hooks.js';
import { JobsService, serverContext } from '../../queues/jobs.service.js';
import { checkSubscribers, EVENTS_QUEUE, subscriberJobId, wants } from './subscriber.js';

const log = new Logger('Events');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why an event cannot be relayed, in a line: a schema's problems by path, or the error. */
export function failureOf(e: unknown): string {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] })?.issues;
  const text = Array.isArray(issues)
    ? `not an event: ${issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
    : message(e);
  return text.slice(0, 1000);
}

/** What one pass of a batch did: relayed, failed for good, or stopped by a queue. */
export interface RelayOutcome {
  relayed: string[];
  failed: { id: string; error: string }[];
  /**
   * Relayed, but not to every subscriber: these subscribers' `when` threw on the event, so they
   * miss it (`error` names each). The other subscribers got it.
   */
  skipped: { id: string; error: string }[];
  /** A queue refused a job: the rest of the batch waits for the next tick. */
  stopped?: string;
}

/** The event, checked, the subscribers that want it, and the ones whose filter threw on it. */
type Routed = { event: DomainEventEnvelope; targets: Subscriber[]; skipped: string[] };

/**
 * Puts each committed event on the queue of every subscriber that wants it: the shared `events`
 * queue for a subscriber with `handle`, its own queue otherwise. The job id is
 * `<subscriber>--<event id>`, so an event relayed twice (a crash between adding and marking it)
 * runs once. An event not yet available (an undo window) waits until then.
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
      const { event, targets, skipped } = this.route(raw);
      for (const why of skipped) log.error(`event ${event.id}: ${why}`);
      await this.add(event, targets);
    }
  }

  /**
   * A batch, each event on its own: one that is not an event fails alone and the rest go on. A
   * subscriber whose `when` throws on an event misses only that event, and only it: the others
   * get it (`skipped` says who missed what). A queue that refuses a job stops the batch there:
   * that is the queue's trouble, not the event's, so it waits for the next tick.
   */
  async relay(events: readonly DomainEventEnvelope[]): Promise<RelayOutcome> {
    const out: RelayOutcome = { relayed: [], failed: [], skipped: [] };
    for (const raw of events) {
      let routed: Routed;
      try {
        routed = this.route(raw);
      } catch (e) {
        out.failed.push({ id: String((raw as { id?: unknown })?.id), error: failureOf(e) });
        continue;
      }
      try {
        await this.add(routed.event, routed.targets);
      } catch (e) {
        out.stopped = message(e);
        break;
      }
      out.relayed.push(routed.event.id);
      if (routed.skipped.length)
        out.skipped.push({ id: routed.event.id, error: routed.skipped.join('; ').slice(0, 1000) });
    }
    return out;
  }

  /**
   * The event, checked (throws when it is not one), every subscriber that wants it, and the ones
   * whose `when` threw on it: those are left out, so one bad filter withholds nothing from the
   * others.
   */
  private route(raw: DomainEventEnvelope): Routed {
    const event = DomainEventEnvelope.parse(raw);
    const targets: Subscriber[] = [];
    const skipped: string[] = [];
    for (const s of subscribers.all()) {
      let wanted: boolean;
      try {
        wanted = wants(s, event);
      } catch (e) {
        skipped.push(`subscriber ${s.name}: ${message(e)}`);
        continue;
      }
      if (wanted) targets.push(s);
    }
    return { event, targets, skipped };
  }

  private async add(event: DomainEventEnvelope, targets: readonly Subscriber[]) {
    const delay = event.availableAt ? Math.max(0, Date.parse(event.availableAt) - Date.now()) : 0;
    for (const s of targets)
      await this.jobs.add(s.queue ?? EVENTS_QUEUE, event, {
        name: s.name,
        jobId: subscriberJobId(s.name, event.id),
        delay,
        attempts: s.attempts ?? 3,
        backoff: { type: 'exponential', delay: s.backoffMs ?? 2000 },
      });
  }
}

const EVERY_MS = 1000;
const BATCH = 100;

/**
 * The worker's poller: each second, each feed's pending events for this queue prefix go to the
 * relay, then are marked relayed. One tick at a time. Feeds get the services (`ctx.db`). An
 * event that cannot be relayed is marked failed (the feed's `failed`) and logged; it never holds
 * up the others, of this business or another. One that some subscriber's filter threw on is
 * relayed to the rest, and that is logged and kept with it (the feed's `skipped`).
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
          const out = await this.relay.relay(events);
          if (out.relayed.length) await feed.relayed(out.relayed, { prefix }, this.ctx);
          if (out.skipped.length) {
            for (const f of out.skipped) log.error(`feed ${feed.name}: event ${f.id}: ${f.error}`);
            await feed.skipped?.(out.skipped, { prefix }, this.ctx);
          }
          if (out.failed.length) {
            for (const f of out.failed) log.error(`feed ${feed.name}: event ${f.id}: ${f.error}`);
            await feed.failed?.(out.failed, { prefix }, this.ctx);
          }
          if (out.stopped) log.error(`feed ${feed.name}: ${out.stopped}`);
        } catch (e) {
          log.error(`feed ${feed.name}: ${message(e)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
