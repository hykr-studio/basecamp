// One place per push (W1): a notification reaches one of the person's devices, the phone or
// browser they used most recently, and the next one only when that one cannot take it.
import { type Database, pushTokens, webPushSubscriptions } from '@hykr/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DeliveryOutcome, DeliveryRequest } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { PushService } from './push.service.js';
import { pushSettings } from './settings.js';
import { WebPushService } from './web.service.js';

/** A device as the choice sees it. */
export interface Place<T = unknown> {
  kind: 'phone' | 'browser';
  /** When the person last used the app there, if it said. */
  activeAt: Date | null;
  /** When it last registered (each sign-in). */
  lastSeenAt: Date;
  row: T;
}

const latest = (p: Place) => Math.max(p.activeAt?.getTime() ?? 0, p.lastSeenAt.getTime());

/**
 * The order to try a person's devices in: those used within `activeMs`, most recent first;
 * then the rest, by their last use or sign-in, most recent first. A tie goes to the phone.
 */
export function orderPlaces<T extends Place>(places: readonly T[], now: number, activeMs: number) {
  const active = (p: Place) => (p.activeAt ? now - p.activeAt.getTime() <= activeMs : false);
  return [...places].sort((a, b) => {
    const byActive = Number(active(b)) - Number(active(a));
    if (byActive) return byActive;
    const byTime = latest(b) - latest(a);
    if (byTime) return byTime;
    return a.kind === b.kind ? 0 : a.kind === 'phone' ? -1 : 1;
  });
}

type Phone = typeof pushTokens.$inferSelect;
type Browser = typeof webPushSubscriptions.$inferSelect;

/** Sends one notification to the one device the person is on, trying the next on a failure. */
@Injectable()
export class PushPlaces {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly phones: PushService,
    private readonly browsers: WebPushService,
  ) {}

  async deliver(
    req: DeliveryRequest,
    kinds: { phones: boolean; browsers: boolean },
  ): Promise<DeliveryOutcome> {
    if (!req.notification.push)
      return { status: 'unavailable', reason: 'the notification has no push text' };
    const userId = req.to.userId;
    if (!userId) return { status: 'unavailable', reason: 'the recipient has no account' };
    const places: Place<Phone | Browser>[] = [];
    if (kinds.phones)
      for (const row of await this.db
        .select()
        .from(pushTokens)
        .where(and(eq(pushTokens.tenantId, req.tenantId), eq(pushTokens.userId, userId))))
        places.push({ kind: 'phone', activeAt: row.activeAt, lastSeenAt: row.lastSeenAt, row });
    // Browsers only when web push is set up: without it they cannot be sent to.
    if (kinds.browsers && this.browsers.publicKey())
      for (const row of await this.db
        .select()
        .from(webPushSubscriptions)
        .where(
          and(
            eq(webPushSubscriptions.tenantId, req.tenantId),
            eq(webPushSubscriptions.userId, userId),
          ),
        ))
        places.push({ kind: 'browser', activeAt: row.activeAt, lastSeenAt: row.lastSeenAt, row });
    if (!places.length)
      return {
        status: 'unavailable',
        reason: kinds.phones ? 'no device registered' : 'no browser registered',
      };

    const reasons: string[] = [];
    let transient = false;
    for (const p of orderPlaces(places, Date.now(), pushSettings.activeMs())) {
      const outcome =
        p.kind === 'phone'
          ? await this.phones.sendTo(req, [p.row as Phone])
          : await this.browsers.sendTo(req, [p.row as Browser]);
      if (outcome.status === 'sent') return outcome;
      reasons.push(outcome.reason);
      if (outcome.status === 'failed' && !outcome.final) transient = true;
    }
    return { status: 'failed', reason: [...new Set(reasons)].join('; '), final: !transient };
  }
}
