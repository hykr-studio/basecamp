import { randomUUID } from 'node:crypto';
import { isEgressBlocked, safeRequest } from '@hykr/connectors';
import type { Principal, PushDevice, WebPushSubscription } from '@hykr/contracts';
import { type Database, pushTickets, webPushSubscriptions } from '@hykr/db';
import type { Row } from '@hykr/notifications';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import webpush from 'web-push';
import { config } from '../../config.js';
import type { DeliveryOutcome, DeliveryRequest } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { secretBox } from '../integrations/settings.js';
import { endpointProblem, vapid, webPushPolicy } from './web.settings.js';

const log = new Logger('WebPush');

/** How long a push service keeps a message for a browser that is offline: a day. */
const TTL_SECONDS = 24 * 60 * 60;
/** The push service says the subscription is gone (unsubscribed, expired): forget it. */
const GONE = new Set([404, 410]);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** What a browser's keys are sealed for: the subscription in its business. */
const aadOf = (tenantId: string, endpoint: string) => `webpush:${tenantId}:${endpoint}`;

/**
 * The endpoint's host and the first 6 characters of its last part: enough to tell browsers
 * apart, not to send to one (the endpoint is the address a push goes to). Sliced, never
 * pattern-replaced, and never more than half of the id.
 */
export function maskEndpoint(endpoint: string): string {
  let host = '';
  let id = endpoint;
  try {
    const url = new URL(endpoint);
    host = url.host;
    id = url.pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    // Not a URL: only its first characters.
  }
  const keep = Math.min(6, Math.floor(id.length / 2));
  return `${host ? `${host}/` : ''}${id.slice(0, keep)}…`;
}

/** A browser's name and system from its User-Agent ("Chrome on macOS"), never the whole string. */
export function browserOf(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS\//.test(ua)
        ? 'Firefox'
        : /SamsungBrowser\//.test(ua)
          ? 'Samsung Internet'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : undefined;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : undefined;
  if (!browser && !os) return undefined;
  return [browser ?? 'A browser', os].filter(Boolean).join(' on ');
}

/** A send's result for one browser. */
type Result = { ok: true } | { ok: false; gone: boolean; transient: boolean; error: string };

/**
 * Web push (VAPID, RFC 8291): a person's browsers, and sending to them. Each browser's message is
 * encrypted for it with its own keys, signed with the deployment's VAPID key, and posted to its
 * push service under the egress guard. Web Push has no receipts: an accepted send is final.
 */
@Injectable()
export class WebPushService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The VAPID public key a browser subscribes with, or null when web push is off. */
  publicKey(): string | null {
    return vapid()?.publicKey ?? null;
  }

  /**
   * This browser, for this person, in the business they work in. A subscription belongs to one
   * person: held by anyone else in any business, it is removed first.
   */
  async register(
    p: Principal,
    sub: WebPushSubscription,
    userAgent: string | undefined,
  ): Promise<PushDevice> {
    const problem = endpointProblem(sub.endpoint);
    if (problem) throw new BadRequestException({ error: 'bad_endpoint', message: problem });
    const box = vapid() ? secretBox() : null;
    if (!box)
      throw new ServiceUnavailableException({
        error: 'unavailable',
        rule: 'webpush_unavailable',
        reason: 'This server has no web push keys',
      });
    const tenantId = p.tenantId ?? '';
    const userId = p.actor.id;
    const aad = aadOf(tenantId, sub.endpoint);
    const sealed = { p256dh: box.seal(sub.keys.p256dh, aad), auth: box.seal(sub.keys.auth, aad) };
    const browser = browserOf(userAgent) ?? null;
    const row = await this.db.transaction(async (tx) => {
      await tx
        .delete(webPushSubscriptions)
        .where(
          and(
            eq(webPushSubscriptions.endpoint, sub.endpoint),
            ne(webPushSubscriptions.userId, userId),
          ),
        );
      const [saved] = await tx
        .insert(webPushSubscriptions)
        .values({ tenantId, userId, endpoint: sub.endpoint, ...sealed, userAgent: browser })
        .onConflictDoUpdate({
          target: [webPushSubscriptions.endpoint, webPushSubscriptions.tenantId],
          set: { userId, ...sealed, userAgent: browser, lastSeenAt: sql`now()` },
        })
        .returning();
      return saved;
    });
    return browserDeviceOf(row);
  }

  /** This person's browsers in this business. */
  async list(p: Principal): Promise<PushDevice[]> {
    const rows = await this.db
      .select()
      .from(webPushSubscriptions)
      .where(
        and(
          eq(webPushSubscriptions.tenantId, p.tenantId ?? ''),
          eq(webPushSubscriptions.userId, p.actor.id),
        ),
      )
      .orderBy(webPushSubscriptions.createdAt);
    return rows.map(browserDeviceOf);
  }

  /** No more pushes to this browser, for anyone, in any business. */
  async forget(endpoint: string) {
    await this.db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, endpoint));
  }

  /**
   * One notification to one person: a message to each of their browsers in this business. Sent
   * when a push service accepted one; unavailable without a browser or without web push; failed
   * for now when one could not be reached or was busy; failed for good otherwise.
   */
  async send(req: DeliveryRequest): Promise<DeliveryOutcome> {
    const content = req.notification.push;
    if (!content) return { status: 'unavailable', reason: 'the notification has no push text' };
    const keys = vapid();
    if (!keys) return { status: 'unavailable', reason: 'web push is not set up' };
    const box = secretBox();
    if (!box) return { status: 'unavailable', reason: 'web push is not set up' };
    const userId = req.to.userId;
    if (!userId) return { status: 'unavailable', reason: 'the recipient has no account' };
    const browsers = await this.db
      .select()
      .from(webPushSubscriptions)
      .where(
        and(
          eq(webPushSubscriptions.tenantId, req.tenantId),
          eq(webPushSubscriptions.userId, userId),
        ),
      );
    if (!browsers.length) return { status: 'unavailable', reason: 'no browser registered' };

    // The record as this recipient may read it (req.row, decisions H1): the same words as a
    // phone's push, and nothing else.
    const row = req.row as Row;
    const url = content.url?.(row as never);
    const payload = JSON.stringify({
      title: content.title(row as never, req.reader),
      body: content.body(row as never, req.reader),
      ...(url ? { url } : {}),
      notification: req.notification.key,
    });
    const urgency =
      req.notification.approval || req.notification.key === 'approval.request' ? 'high' : 'normal';

    const results: Result[] = [];
    for (const b of browsers) results.push(await this.sendOne(b, payload, urgency, keys, box));

    const send = randomUUID();
    await this.db.insert(pushTickets).values(
      browsers.map((b, i) => {
        const r = results[i];
        return {
          tenantId: req.tenantId,
          userId,
          send,
          token: b.id,
          platform: 'web',
          receiptId: null,
          notification: req.notification.key,
          dedupe: req.dedupe,
          meta: req.meta,
          status: r.ok ? ('ok' as const) : ('error' as const),
          error: r.ok ? null : r.error,
          queues: config.queuePrefix,
          checkedAt: sql`now()`,
        };
      }),
    );
    const gone = browsers.filter((_, i) => {
      const r = results[i];
      return !r.ok && r.gone;
    });
    if (gone.length)
      await this.db.delete(webPushSubscriptions).where(
        inArray(
          webPushSubscriptions.id,
          gone.map((b) => b.id),
        ),
      );

    if (results.some((r) => r.ok)) return { status: 'sent', ref: send };
    const errors = results.flatMap((r) => (r.ok ? [] : [r.error]));
    const reason = `web push refused: ${[...new Set(errors)].join(', ')}`;
    return { status: 'failed', reason, final: !results.some((r) => !r.ok && r.transient) };
  }

  private async sendOne(
    b: typeof webPushSubscriptions.$inferSelect,
    payload: string,
    urgency: 'high' | 'normal',
    keys: { publicKey: string; privateKey: string; subject: string },
    box: NonNullable<ReturnType<typeof secretBox>>,
  ): Promise<Result> {
    // Registered when it was allowed; checked again in case the allowed hosts changed since.
    const problem = endpointProblem(b.endpoint);
    if (problem) return { ok: false, gone: true, transient: false, error: problem };
    let details: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      const aad = aadOf(b.tenantId, b.endpoint);
      details = webpush.generateRequestDetails(
        {
          endpoint: b.endpoint,
          keys: { p256dh: box.open(b.p256dh, aad), auth: box.open(b.auth, aad) },
        },
        payload,
        {
          vapidDetails: keys,
          TTL: TTL_SECONDS,
          urgency,
          contentEncoding: 'aes128gcm',
        },
      );
    } catch (e) {
      // Keys that do not open here (another SECRETS_KEY) or do not encrypt: this one is lost.
      log.warn(`a browser's subscription cannot be used: ${message(e)}`);
      return { ok: false, gone: true, transient: false, error: 'BadSubscription' };
    }
    try {
      const res = await safeRequest(
        details.endpoint,
        {
          method: details.method,
          headers: details.headers as Record<string, string>,
          body: details.body ?? undefined,
        },
        webPushPolicy(),
      );
      if (res.status === 201 || res.status === 202 || res.status === 200) return { ok: true };
      return {
        ok: false,
        gone: GONE.has(res.status),
        transient: res.status === 429 || res.status >= 500,
        error: `HTTP ${res.status}`,
      };
    } catch (e) {
      if (isEgressBlocked(e))
        return { ok: false, gone: false, transient: false, error: `blocked: ${message(e)}` };
      return { ok: false, gone: false, transient: true, error: message(e) };
    }
  }
}

function browserDeviceOf(row: typeof webPushSubscriptions.$inferSelect): PushDevice {
  return {
    id: row.id,
    platform: 'web',
    token: maskEndpoint(row.endpoint),
    ...(row.userAgent ? { browser: row.userAgent } : {}),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
