import { randomUUID } from 'node:crypto';
import type { Principal, PushDevice, RegisterPushToken } from '@hykr/contracts';
import { type Database, pushTickets, pushTokens } from '@hykr/db';
import type { Row } from '@hykr/notifications';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { NotifyService } from '../../channels/notify/notify.service.js';
import { config } from '../../config.js';
import type { DeliveryOutcome, DeliveryRequest, NotificationMeta } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { pushSettings } from './settings.js';

const log = new Logger('Push');

/** The push service refused for now: trying again later may work. Anything else is final. */
const TRANSIENT = new Set(['MessageRateExceeded', 'ExpoError', 'ProviderError']);
/** The app is gone from the device (or notifications are off for good): forget the token. */
const GONE = 'DeviceNotRegistered';
/** Receipts are kept about a day; one that never came by then will not come. */
const RECEIPT_LIFETIME_MS = 24 * 60 * 60_000;
/** Receipts asked for in one poll. */
const POLL_BATCH = 900;

type ExpoClient = InstanceType<typeof import('expo-server-sdk').Expo>;

/**
 * Loaded on first use: the SDK reads the push service's address (EXPO_BASE_URL) when it loads,
 * so a test can point it at a stand-in before the first send.
 */
let sdk: Promise<typeof import('expo-server-sdk')> | undefined;
const loadSdk = () => {
  sdk ??= import('expo-server-sdk');
  return sdk;
};

const errorOf = (t: { details?: { error?: string }; message?: string }) =>
  t.details?.error ?? t.message ?? 'unknown';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The token's first characters: enough to tell devices apart, not to send to one. An Expo
 * token's prefix (`ExponentPushToken[`, `ExpoPushToken[`) says nothing, so the mask keeps it and
 * 6 characters of the id; a token without one, its first 8. Sliced, never pattern-replaced: a
 * replace that misses would return the token whole. The device list and the export use it.
 */
export function maskToken(token: string): string {
  const open = token.indexOf('[');
  return `${token.slice(0, open >= 0 ? open + 7 : 8)}…`;
}

/** Push (Expo): devices, sending, and the receipts that say how a send went. */
@Injectable()
export class PushService {
  private client: ExpoClient | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {}

  private async expo(): Promise<ExpoClient> {
    if (this.client) return this.client;
    const { Expo } = await loadSdk();
    const accessToken = pushSettings.accessToken();
    this.client = new Expo(accessToken ? { accessToken } : {});
    return this.client;
  }

  /**
   * This device, for this person, in the business they work in. A device belongs to one person:
   * the same token anywhere else (another person, in any business) is removed first.
   */
  async register(p: Principal, input: RegisterPushToken): Promise<PushDevice> {
    const { Expo } = await loadSdk();
    if (!Expo.isExpoPushToken(input.token))
      throw new BadRequestException({ error: 'bad_token', message: 'Not an Expo push token' });
    const tenantId = p.tenantId ?? '';
    const userId = p.actor.id;
    const row = await this.db.transaction(async (tx) => {
      await tx
        .delete(pushTokens)
        .where(and(eq(pushTokens.token, input.token), ne(pushTokens.userId, userId)));
      const [saved] = await tx
        .insert(pushTokens)
        .values({ tenantId, userId, token: input.token, platform: input.platform })
        .onConflictDoUpdate({
          target: [pushTokens.token, pushTokens.tenantId],
          set: { userId, platform: input.platform, lastSeenAt: sql`now()` },
        })
        .returning();
      return saved;
    });
    return deviceOf(row);
  }

  /** This person's devices in this business. */
  async devices(p: Principal): Promise<PushDevice[]> {
    const rows = await this.db
      .select()
      .from(pushTokens)
      .where(and(eq(pushTokens.tenantId, p.tenantId ?? ''), eq(pushTokens.userId, p.actor.id)))
      .orderBy(pushTokens.createdAt);
    return rows.map(deviceOf);
  }

  /** No more pushes to this device, for anyone, in any business. */
  async forget(token: string) {
    await this.db.delete(pushTokens).where(eq(pushTokens.token, token));
  }

  /**
   * One notification to one person: a message to each of their devices in this business. Sent
   * when the push service accepted at least one; unavailable without a device; failed for now
   * when it could not be reached or refused for now; failed for good otherwise.
   */
  async send(req: DeliveryRequest): Promise<DeliveryOutcome> {
    const content = req.notification.push;
    if (!content) return { status: 'unavailable', reason: 'the notification has no push text' };
    const userId = req.to.userId;
    if (!userId) return { status: 'unavailable', reason: 'the recipient has no account' };
    const devices = await this.db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(and(eq(pushTokens.tenantId, req.tenantId), eq(pushTokens.userId, userId)));
    if (!devices.length) return { status: 'unavailable', reason: 'no device registered' };

    const row = req.row as Row;
    const url = content.url?.(row as never);
    const messages: ExpoPushMessage[] = devices.map((d) => ({
      to: d.token,
      title: content.title(row as never, req.reader),
      body: content.body(row as never, req.reader),
      data: { notification: req.notification.key, ...(url ? { url } : {}) },
      sound: 'default',
      channelId: 'default',
    }));
    const expo = await this.expo();
    const tickets: ExpoPushTicket[] = [];
    try {
      for (const chunk of expo.chunkPushNotifications(messages))
        tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
    } catch (e) {
      return { status: 'failed', reason: `push service: ${message(e)}`, final: false };
    }

    const send = randomUUID();
    const meta: NotificationMeta = req.meta;
    const errors: string[] = [];
    await this.db.insert(pushTickets).values(
      tickets.map((t, i) => {
        if (t.status !== 'ok') errors.push(errorOf(t));
        return {
          tenantId: req.tenantId,
          userId,
          send,
          token: devices[i].token,
          receiptId: t.status === 'ok' ? t.id : null,
          notification: req.notification.key,
          dedupe: req.dedupe,
          meta,
          status: t.status === 'ok' ? ('pending' as const) : ('error' as const),
          error: t.status === 'ok' ? null : errorOf(t),
          queues: config.queuePrefix,
        };
      }),
    );
    const gone = tickets.flatMap((t, i) =>
      t.status !== 'ok' && errorOf(t) === GONE ? [devices[i].token] : [],
    );
    if (gone.length) await this.db.delete(pushTokens).where(inArray(pushTokens.token, gone));

    if (tickets.some((t) => t.status === 'ok')) return { status: 'sent', ref: send };
    const reason = `push refused: ${[...new Set(errors)].join(', ')}`;
    return { status: 'failed', reason, final: !errors.some((e) => TRANSIENT.has(e)) };
  }

  /**
   * Check the receipts of this queue prefix's sends that are old enough to have one. A receipt
   * with an error marks its message failed (and forgets a device that is gone); a send whose
   * every message failed moves its notification to the next channel. A message without a
   * receipt after a day is expired: it counts as delivered.
   */
  async pollReceipts(prefix = config.queuePrefix): Promise<{ checked: number; fellBack: number }> {
    const due = await this.db
      .select({
        id: pushTickets.id,
        receiptId: pushTickets.receiptId,
        createdAt: pushTickets.createdAt,
      })
      .from(pushTickets)
      .where(
        and(
          eq(pushTickets.queues, prefix),
          eq(pushTickets.status, 'pending'),
          lte(
            pushTickets.createdAt,
            sql`now() - make_interval(secs => ${pushSettings.receiptDelayMs() / 1000})`,
          ),
        ),
      )
      .orderBy(pushTickets.createdAt)
      .limit(POLL_BATCH);
    if (!due.length) return { checked: 0, fellBack: 0 };

    const expo = await this.expo();
    const receipts: Record<
      string,
      { status: string; message?: string; details?: { error?: string } }
    > = {};
    const ids = due.flatMap((t) => (t.receiptId ? [t.receiptId] : []));
    for (const chunk of expo.chunkPushNotificationReceiptIds(ids))
      Object.assign(receipts, await expo.getPushNotificationReceiptsAsync(chunk));

    const failed: string[] = [];
    let checked = 0;
    for (const t of due) {
      const receipt = t.receiptId ? receipts[t.receiptId] : undefined;
      const expired = Date.now() - t.createdAt.getTime() > RECEIPT_LIFETIME_MS;
      if (!receipt && !expired) continue;
      const error = receipt && receipt.status !== 'ok' ? errorOf(receipt) : null;
      const status = receipt ? (error ? 'error' : 'ok') : 'expired';
      // Only a pending ticket moves: two polls of one prefix never decide one twice.
      const [moved] = await this.db
        .update(pushTickets)
        .set({ status, error, checkedAt: sql`now()` })
        .where(and(eq(pushTickets.id, t.id), eq(pushTickets.status, 'pending')))
        .returning({ send: pushTickets.send, token: pushTickets.token });
      if (!moved) continue;
      checked++;
      if (!error) continue;
      failed.push(moved.send);
      if (error === GONE) await this.db.delete(pushTokens).where(eq(pushTokens.token, moved.token));
    }

    let fellBack = 0;
    for (const send of new Set(failed)) {
      const all = await this.db
        .select({ status: pushTickets.status, meta: pushTickets.meta })
        .from(pushTickets)
        .where(eq(pushTickets.send, send));
      if (!all.every((t) => t.status === 'error')) continue;
      const meta = all[0]?.meta as NotificationMeta | null;
      if (!meta?.next.length) continue;
      await this.ref.get(NotifyService, { strict: false }).fallback(meta, `push-${send}`);
      fellBack++;
    }
    if (checked) log.log(`checked ${checked} push receipts; ${fellBack} sends moved on`);
    return { checked, fellBack };
  }
}

function deviceOf(row: typeof pushTokens.$inferSelect): PushDevice {
  return {
    id: row.id,
    platform: row.platform,
    token: maskToken(row.token),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
