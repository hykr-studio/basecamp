import { isNamedEvent } from '@app/core';
import { type Database, type DbOrTx, schema } from '@app/db';
import type { Labels } from '@app/i18n';
import { type NotificationDef, notifications, type Row } from '@app/notifications';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { QUEUES } from '../queues.js';
import { REDIS } from '../whatsapp/adapter.provider.js';

const log = new Logger('Notify');

/** One notify-dispatch job: a notification about one record, now or at a time. */
export type DispatchJob = {
  key: string;
  tenantId: string;
  row: Row;
  dedupe: string;
  /** When it was scheduled for (a scheduled one checks it is still the latest). */
  scheduledFor?: string;
  /** Fallback: only these channels, for this one recipient. */
  only?: { channels: ('whatsapp' | 'email')[]; recipient: Record<string, string> };
};

/** The dispatch job for a notification (BullMQ ids may not contain ':'). */
export const jobIdOf = (dedupe: string) => dedupe.replaceAll(':', '_');
export const scheduledJobId = (dedupe: string, scheduledFor: string) =>
  jobIdOf(`${dedupe}@${scheduledFor}`);

/** Dates as ISO strings: what a job and the notification functions see. */
const plain = (row: unknown): Row => JSON.parse(JSON.stringify(row)) as Row;

/**
 * Notifications, in: scheduled from the events notifications name (a reschedule replaces the
 * pending one, a cancel removes it), or sent now with notify(). Everything ends in
 * notify-dispatch, which decides how.
 */
@Injectable()
export class NotifyService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(QUEUES.dispatch) private readonly dispatch: Queue<DispatchJob>,
  ) {}

  onModuleInit() {
    this.events.subscribe((event) => {
      if (!isNamedEvent(event)) return;
      this.onEvent(event.eventName, plain(event.row)).catch((e) =>
        log.error(`scheduling on ${event.eventName} failed: ${e instanceof Error ? e.message : e}`),
      );
    });
  }

  /** The latest schedule per notification: a job scheduled before it is stale and skips. */
  private latestKey = (dedupe: string) => `${config.queuePrefix}:ntf:${dedupe}`;

  async isCurrent(job: DispatchJob) {
    if (!job.scheduledFor) return true;
    return (await this.redis.get(this.latestKey(job.dedupe))) === job.scheduledFor;
  }

  private async onEvent(name: string, row: Row) {
    for (const def of notifications) {
      if (def.send?.on.includes(name)) {
        if (def.when && !def.when(row)) continue;
        const dedupe = def.dedupe(row);
        await this.dispatch.add(
          'now',
          { key: def.key, tenantId: row.tenantId, row, dedupe },
          { jobId: jobIdOf(dedupe), attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
      }
      const schedule = def.schedule;
      if (!schedule) continue;
      if (schedule.cancelOn?.includes(name)) await this.cancel(def.dedupe(row));
      else if (schedule.on.includes(name)) await this.schedule(def, row, schedule.at(row));
    }
  }

  /**
   * Schedule it (replacing any pending one), or cancel it when there is no time. Each schedule
   * is its own job (`<dedupe>@<time>`), so a job can move itself (quiet hours) while it runs;
   * the latest time, kept in Redis, says which one stands.
   */
  async schedule(def: NotificationDef, row: Row, at: Date | null) {
    const dedupe = def.dedupe(row);
    if (!at || at.getTime() <= Date.now()) return this.cancel(dedupe);
    const scheduledFor = at.toISOString();
    await this.removePending(dedupe);
    // Kept a day past its time, then Redis forgets it.
    await this.redis.set(this.latestKey(dedupe), scheduledFor, 'PXAT', at.getTime() + 86_400_000);
    await this.dispatch.add(
      'scheduled',
      { key: def.key, tenantId: row.tenantId, row, dedupe, scheduledFor },
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
   * Send a notification about this record now. Inside a command, pass its transaction: the
   * notification is written to the outbox with the change, so a rollback sends nothing and a
   * crash after commit still sends it.
   */
  async notify(def: NotificationDef, row: unknown, tx?: DbOrTx) {
    const r = plain(row);
    await (tx ?? this.db).insert(schema.outbox).values({
      tenantId: r.tenantId,
      key: def.key,
      payload: { row: r, dedupe: def.dedupe(r) },
    });
  }

  /**
   * A quick-reply button on a notification (`ntf:<key>:<button>`): the notification's own
   * handler decides (snooze schedules it again). The record comes from the message it answers,
   * or the latest one of that notification to this contact. Returns what to say back.
   */
  async tapped(contactId: string, payload: string, replyTo?: string): Promise<Labels | undefined> {
    const [, key, button] = payload.split(':');
    const def = notifications.find((n) => n.key === key);
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
    const row = (sent?.meta as { row?: Row } | null)?.row;
    if (!row) return undefined;
    const result = handler(row as never);
    if (result?.reschedule) await this.schedule(def, row, result.reschedule);
    return result?.reply;
  }
}
