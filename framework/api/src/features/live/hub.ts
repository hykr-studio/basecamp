import type { LiveEvent, Principal } from '@hykr/contracts';
import { entityDef } from '@hykr/core';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { config } from '../../config.js';
import type { ServerContext } from '../../hooks.js';
import { serverContext } from '../../queues/jobs.service.js';
import { liveResources } from './resources.js';
import { type LiveSignal, liveChannel, parseSignal } from './signal.js';

const log = new Logger('Live');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A comment every this often keeps proxies from dropping a quiet stream. */
const HEARTBEAT_MS = 25_000;
/** Streams per person per process. */
const PER_PERSON = 8;
/** Records a stream remembers it was told about (for later changes it can no longer read). */
const KNOWN = 500;

/** How long one stream stays open: then the client reconnects, with its session checked again. */
const maxMs = () => {
  const n = Number(process.env.LIVE_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000;
};

type Connection = {
  p: Principal;
  /** The principal as a cache key: connections of one person share a check within one event. */
  key: string;
  userId: string;
  tenantId: string;
  res: Response;
  known: Set<string>;
  timers: NodeJS.Timeout[];
  closed: boolean;
};

const recordKey = (s: { type: string; id: string }) => `${s.type}:${s.id}`;

/**
 * The live streams this API process holds, by business, and the Redis subscription that feeds
 * them. Each signal goes to a connection only when that person may read the record now (or was
 * told about it before on this stream, or made the change), as ids only.
 */
@Injectable()
export class LiveHub implements OnModuleDestroy, OnApplicationShutdown {
  private readonly byTenant = new Map<string, Set<Connection>>();
  /** One chain per business: signals are checked and sent in the order they arrive. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Each business's Redis subscription, while it has streams: a stream waits for it. */
  private readonly subscriptions = new Map<string, Promise<void>>();
  private redis: Redis | undefined;
  private readonly ctx: ServerContext;

  constructor(@Inject(ModuleRef) ref: ModuleRef) {
    this.ctx = serverContext(ref);
  }

  /** How many streams are open (for tests and health). */
  count(tenantId?: string) {
    if (tenantId) return this.byTenant.get(tenantId)?.size ?? 0;
    let n = 0;
    for (const set of this.byTenant.values()) n += set.size;
    return n;
  }

  /** Open a stream for this person on this response. Resolves once it is subscribed. */
  async open(p: Principal, res: Response) {
    const tenantId = p.tenantId;
    if (!tenantId) throw new HttpException({ error: 'forbidden', rule: 'no_tenant' }, 403);
    const userId = p.actor.id;
    const mine = [...(this.byTenant.get(tenantId) ?? [])].filter((c) => c.userId === userId);
    if (mine.length >= PER_PERSON)
      throw new HttpException(
        { error: 'too_many_streams', message: `At most ${PER_PERSON} live streams per person` },
        429,
      );

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    // no-transform: nothing on the way may compress (and so hold back) the stream.
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    const conn: Connection = {
      p,
      key: JSON.stringify(p),
      userId,
      tenantId,
      res,
      known: new Set(),
      timers: [],
      closed: false,
    };
    const set = this.byTenant.get(tenantId) ?? new Set<Connection>();
    set.add(conn);
    this.byTenant.set(tenantId, set);
    // The client went away (or the response ended): forget the stream.
    const close = () => this.close(conn);
    res.on('close', close);
    res.on('error', close);
    conn.timers.push(setInterval(() => this.write(conn, ': ping\n\n'), HEARTBEAT_MS));
    conn.timers.push(setTimeout(() => this.close(conn), maxMs()));
    let subscribed = this.subscriptions.get(tenantId);
    if (!subscribed) {
      subscribed = this.subscribe(tenantId);
      this.subscriptions.set(tenantId, subscribed);
    }
    try {
      await subscribed;
    } catch (e) {
      log.error(`subscribing for live updates failed: ${message(e)}`);
      if (this.subscriptions.get(tenantId) === subscribed) this.subscriptions.delete(tenantId);
      this.close(conn);
      return;
    }
    this.write(conn, 'event: ready\ndata: {}\n\n');
  }

  private write(conn: Connection, text: string) {
    if (conn.closed) return;
    try {
      conn.res.write(text);
    } catch {
      this.close(conn);
    }
  }

  private close(conn: Connection) {
    if (conn.closed) return;
    conn.closed = true;
    for (const t of conn.timers) clearTimeout(t);
    try {
      conn.res.end();
    } catch {
      // already gone
    }
    const set = this.byTenant.get(conn.tenantId);
    set?.delete(conn);
    if (set && set.size === 0) {
      this.byTenant.delete(conn.tenantId);
      this.subscriptions.delete(conn.tenantId);
      this.redis
        ?.unsubscribe(liveChannel(config.queuePrefix, conn.tenantId))
        .catch((e) => log.warn(`unsubscribe failed: ${message(e)}`));
    }
  }

  private async subscribe(tenantId: string) {
    if (!this.redis) {
      this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      this.redis.on('message', (_channel: string, raw: string) => this.received(raw));
      this.redis.on('error', (e) => log.warn(`redis: ${message(e)}`));
    }
    await this.redis.subscribe(liveChannel(config.queuePrefix, tenantId));
  }

  private received(raw: string) {
    const signal = parseSignal(raw);
    if (!signal || !this.byTenant.has(signal.tenantId)) return;
    const previous = this.chains.get(signal.tenantId) ?? Promise.resolve();
    const next = previous
      .then(() => this.fanOut(signal))
      .catch((e) => log.error(`live ${signal.name}: ${message(e)}`));
    this.chains.set(signal.tenantId, next);
    void next.then(() => {
      if (this.chains.get(signal.tenantId) === next) this.chains.delete(signal.tenantId);
    });
  }

  /** Each of the business's streams that may hear of it gets the event's name, type and id. */
  async fanOut(signal: LiveSignal) {
    const conns = [...(this.byTenant.get(signal.tenantId) ?? [])];
    if (!conns.length) return;
    const seen = new Map<string, Promise<boolean>>();
    const key = recordKey(signal);
    const event: LiveEvent = { name: signal.name, type: signal.type, id: signal.id };
    const text = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const conn of conns) {
      if (conn.closed || conn.tenantId !== signal.tenantId) continue;
      let check = seen.get(conn.key);
      if (!check) {
        check = this.visible(conn.p, signal);
        seen.set(conn.key, check);
      }
      const readable = await check;
      const madeIt =
        (signal.actor.kind === 'user' && signal.actor.id === conn.userId) ||
        signal.subject === `user:${conn.userId}`;
      if (!readable && !conn.known.has(key) && !madeIt) continue;
      if (readable) this.remember(conn, key);
      this.write(conn, text);
    }
  }

  private remember(conn: Connection, key: string) {
    conn.known.delete(key);
    conn.known.add(key);
    if (conn.known.size > KNOWN) {
      const oldest = conn.known.values().next().value;
      if (oldest !== undefined) conn.known.delete(oldest);
    }
  }

  /**
   * May this person read the record now? A registered check for its type, else the entity's own
   * scoped read (as GET /api/<plural>/:id: role grants, then every plugin's scope). Anything
   * else, or a check that throws, is no.
   */
  private async visible(p: Principal, s: LiveSignal): Promise<boolean> {
    try {
      const custom = liveResources.get(s.type);
      if (custom) return await custom.visible(p, s.id, this.ctx);
      const def = entityDef(s.type);
      if (!def) return false;
      return (await def.repo.find(this.ctx.db, p, s.id)) !== undefined;
    } catch {
      return false;
    }
  }

  /** Before the HTTP server closes: end every stream, or it would wait for them. */
  onModuleDestroy() {
    for (const set of [...this.byTenant.values()]) for (const conn of [...set]) this.close(conn);
  }

  async onApplicationShutdown() {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }
}
