import type { DomainEventEnvelope } from '@hykr/contracts';
import { type Database, type DbOrTx, schema } from '@hykr/db';
import type { Labels } from '@hykr/i18n';
import { channelsOf, type NotificationDef, type Row } from '@hykr/notifications';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { deliveryChannels, type NotificationMeta } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { runtime } from '../../runtime.js';
import { QUEUES } from '../queues.js';
import { REDIS } from '../whatsapp/adapter.provider.js';
import { queueNotification } from './queue.js';

/** Read when used: this module may load before the application registers. */
const notifications = () => runtime().notifications.notifications;

/** One notify-dispatch job: a notification about one record, now or at a time. */
export type DispatchJob = {
  key: string;
  tenantId: string;
  row: Row;
  /**
   * The record's type ('visit', 'approval'): each recipient's words read the row as that type
   * (decisions H1). Absent on a template sent by hand, whose row is the sender's own input.
   */
  resourceType?: string;
  dedupe: string;
  /** When it was scheduled for (a scheduled one checks it is still the latest). */
  scheduledFor?: string;
  /** Fallback or retry: only these channels, for this one recipient. */
  only?: { channels: string[]; recipient: Record<string, string> };
  /** A retry of a channel that failed for now: how many tries so far. */
  attempt?: number;
};

/** The channels the dispatcher itself knows; every other name is a registered delivery channel. */
export const BUILT_IN_CHANNELS: readonly string[] = ['whatsapp', 'email'];

/** The dispatch job for a notification (BullMQ ids may not contain ':'). */
export const jobIdOf = (dedupe: string) => dedupe.replaceAll(':', '_');
export const scheduledJobId = (dedupe: string, scheduledFor: string) =>
  jobIdOf(`${dedupe}@${scheduledFor}`);

/** Every event a notification names: what the stored-event subscriber passes on. */
let named: Set<string> | undefined;
export function namedByNotifications(name: string): boolean {
  named ??= new Set(
    notifications().flatMap((d) => [
      ...(d.send?.on ?? []),
      ...(d.schedule?.on ?? []),
      ...(d.schedule?.cancelOn ?? []),
    ]),
  );
  return named.has(name);
}

/** The record type a notification is about, from the first event it names ('visit.created'). */
export const typeFromEvents = (def: NotificationDef<Row>): string | undefined =>
  (def.send?.on[0] ?? def.schedule?.on[0])?.split('.')[0];

/**
 * Applies an event's schedule only when no later event's was applied for this notification:
 * `KEYS[1]` holds the time of the last one applied, `ARGV[1]` is this event's, `ARGV[2]` how long
 * to keep it (ms).
 */
const NEWEST = `
local cur = redis.call('GET', KEYS[1])
if cur and cur > ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`;
const KEEP_EVENT_MS = 2 * 86_400_000;

/**
 * Notifications, in: scheduled from the stored events notifications name (a reschedule replaces
 * the pending one, a cancel removes it), or sent now through the outbox. Everything ends in
 * notify-dispatch, which decides how. Stored events, not in-process ones: an event exists only
 * once its write committed, a crash after commit still schedules it, and an undoable write's
 * events (held for its window, withdrawn by an undo) schedule nothing until the window closes.
 */
@Injectable()
export class NotifyService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(QUEUES.dispatch) private readonly dispatch: Queue<DispatchJob>,
  ) {}

  /**
   * Every channel a notification names is built in or registered: checked once everything has
   * registered, so a missing feature stops the start instead of a notification going nowhere.
   */
  onApplicationBootstrap() {
    for (const name of deliveryChannels.all().map((c) => c.name))
      if (BUILT_IN_CHANNELS.includes(name))
        throw new Error(`The delivery channel "${name}" is built in: pick another name`);
    for (const def of notifications())
      for (const channel of channelsOf(def))
        if (!BUILT_IN_CHANNELS.includes(channel) && !deliveryChannels.has(channel))
          throw new Error(
            `Notification ${def.key} goes by ${channel}, which is not a registered delivery channel`,
          );
  }

  /**
   * A channel failed for good after it had accepted the send (WhatsApp says the number is not on
   * WhatsApp, a push receipt says the token is gone): the notification moves on to the channels
   * after it, for that one recipient. `ref` (the failed message) keeps the job unique.
   */
  async fallback(meta: NotificationMeta, ref: string) {
    if (!meta.next.length) return;
    await this.dispatch.add(
      'fallback',
      {
        key: meta.key,
        tenantId: meta.row.tenantId,
        row: meta.row,
        ...(meta.resourceType ? { resourceType: meta.resourceType } : {}),
        dedupe: meta.dedupe,
        only: { channels: meta.next, recipient: meta.recipient as Record<string, string> },
      },
      { jobId: jobIdOf(`${meta.dedupe}:fallback:${ref}`), attempts: 3 },
    );
  }

  /** The same dispatch for one recipient again, later: a channel that failed for now. */
  async retry(job: DispatchJob, delayMs: number, channel: string) {
    const who = Object.entries(job.only?.recipient ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    await this.dispatch.add('retry', job, {
      jobId: jobIdOf(`${job.dedupe}:retry:${channel}:${who}:${job.attempt ?? 0}`),
      delay: delayMs,
    });
  }

  /** The latest schedule per notification: a job scheduled before it is stale and skips. */
  private latestKey = (dedupe: string) => `${config.queuePrefix}:ntf:${dedupe}`;

  async isCurrent(job: DispatchJob) {
    if (!job.scheduledFor) return true;
    return (await this.redis.get(this.latestKey(job.dedupe))) === job.scheduledFor;
  }

  /**
   * One stored event (the `notify.events` subscriber): every notification that names it is sent
   * now, scheduled or cancelled. A schedule moves only forward in time: an event older than the
   * last one applied to the same notification (relayed late, or by another worker) is skipped.
   */
  async onStored(event: DomainEventEnvelope) {
    const stored = event.row;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    const row = { ...(stored as Row), tenantId: event.tenantId } as Row;
    if (typeof row.id !== 'string') return;
    const resourceType = event.resourceType;
    for (const def of notifications()) {
      if (def.send?.on.includes(event.name)) {
        if (def.when && !def.when(row)) continue;
        const dedupe = def.dedupe(row);
        await this.dispatch.add(
          'now',
          { key: def.key, tenantId: row.tenantId, row, resourceType, dedupe },
          { jobId: jobIdOf(dedupe), attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
      }
      const schedule = def.schedule;
      if (!schedule) continue;
      const cancels = schedule.cancelOn?.includes(event.name);
      if (!cancels && !schedule.on.includes(event.name)) continue;
      const dedupe = def.dedupe(row);
      if (!(await this.newest(dedupe, event.occurredAt))) continue;
      if (cancels) await this.cancel(dedupe);
      else await this.schedule(def, row, schedule.at(row), resourceType);
    }
  }

  /** Is this the newest event applied to this notification yet? Marks it applied when it is. */
  private async newest(dedupe: string, occurredAt: string): Promise<boolean> {
    const applied = await this.redis.eval(
      NEWEST,
      1,
      `${config.queuePrefix}:ntf-ev:${dedupe}`,
      occurredAt,
      String(KEEP_EVENT_MS),
    );
    return applied === 1;
  }

  /**
   * Schedule it (replacing any pending one), or cancel it when there is no time. Each schedule
   * is its own job (`<dedupe>@<time>`), so a job can move itself (quiet hours) while it runs;
   * the latest time, kept in Redis, says which one stands.
   */
  async schedule(def: NotificationDef, row: Row, at: Date | null, resourceType?: string) {
    const dedupe = def.dedupe(row);
    if (!at || at.getTime() <= Date.now()) return this.cancel(dedupe);
    const scheduledFor = at.toISOString();
    await this.removePending(dedupe);
    // Kept a day past its time, then Redis forgets it.
    await this.redis.set(this.latestKey(dedupe), scheduledFor, 'PXAT', at.getTime() + 86_400_000);
    await this.dispatch.add(
      'scheduled',
      {
        key: def.key,
        tenantId: row.tenantId,
        row,
        ...(resourceType ? { resourceType } : {}),
        dedupe,
        scheduledFor,
      },
      {
        jobId: scheduledJobId(dedupe, scheduledFor),
        delay: at.getTime() - Date.now(),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }

  async cancel(dedupe: string) {
    await this.removePending(dedupe);
    await this.redis.del(this.latestKey(dedupe));
  }

  /** When it is scheduled for now, if it is. */
  scheduledFor(dedupe: string) {
    return this.redis.get(this.latestKey(dedupe));
  }

  /** The pending job goes; a running one can't be removed, and finds itself stale instead. */
  private async removePending(dedupe: string) {
    const previous = await this.redis.get(this.latestKey(dedupe));
    if (previous)
      await this.dispatch.remove(scheduledJobId(dedupe, previous)).catch(() => undefined);
  }

  /**
   * Send a notification about this record now, through the outbox (`queueNotification`). Inside
   * a write, pass its transaction: a rollback sends nothing, and an undoable write holds it.
   */
  async notify(def: NotificationDef, row: unknown, opts: { type: string; tx?: DbOrTx }) {
    await queueNotification(opts.tx ?? this.db, def, row, { type: opts.type });
  }

  /**
   * A quick-reply button on a notification (`ntf:<key>:<button>`): the notification's own
   * handler decides (snooze schedules it again). The record comes from the message it answers,
   * or the latest one of that notification to this contact. Returns what to say back.
   */
  async tapped(contactId: string, payload: string, replyTo?: string): Promise<Labels | undefined> {
    // ntf:<key>:<button>, where the key may itself hold a colon (template:<name>).
    const rest = payload.slice('ntf:'.length);
    const key = rest.slice(0, rest.lastIndexOf(':'));
    const button = rest.slice(rest.lastIndexOf(':') + 1);
    const def = notifications().find((n) => n.key === key);
    const handler = button ? def?.onButton?.[button] : undefined;
    if (!def || !handler) return undefined;
    const { messages } = schema;
    const [sent] = await this.db
      .select({ meta: messages.meta })
      .from(messages)
      .where(
        and(
          eq(messages.contactId, contactId),
          eq(messages.notification, def.key),
          replyTo ? eq(messages.providerMessageId, replyTo) : undefined,
        ),
      )
      .orderBy(desc(messages.at))
      .limit(1);
    const meta = sent?.meta as { row?: Row; resourceType?: string } | null;
    const row = meta?.row;
    if (!row) return undefined;
    const result = handler(row as never);
    if (result?.reschedule) await this.schedule(def, row, result.reschedule, meta?.resourceType);
    return result?.reply;
  }
}
