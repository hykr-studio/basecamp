import { bodyKey, checkEvent, type InboundEvent, type InboundRequest } from '@hykr/connectors';
import { capabilities as capabilityRegistry, type WriteResult } from '@hykr/contracts';
import { recordEvents, runWrite, systemPrincipal, type WriteOp } from '@hykr/core';
import {
  type Database,
  integrationAccounts,
  integrationConnections,
  integrationInbound,
  integrationUnrouted,
} from '@hykr/db';
import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { and, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import type { Jobs, ServerContext } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { serverContext } from '../../queues/jobs.service.js';
import { openConnection } from './credentials.js';
import { isOAuthConnector, sharedApp } from './oauth/settings.js';
import { forgetOldSignIns } from './oauth/sign-in.js';
import {
  accessTokenFor,
  accountTokenFor,
  connectorRequest,
  isNeedsReauth,
  markNeedsReauth,
} from './oauth/tokens.js';
import { IntegrationEvent } from './ops.js';
import {
  type ConnectorHandler,
  type ConnectorHandlerContext,
  connectorHandlers,
  connectors,
  handlersFor,
  type InboundEventRecord,
} from './registry.js';
import { requireSecretBox } from './settings.js';

const log = new Logger('Inbound');

export const INBOUND_QUEUE = 'integrations.inbound';
export type InboundJob = { inboundId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres text and jsonb cannot hold NUL, and a handler's error may carry what came in. */
const storable = (text: string) => text.replaceAll('\u0000', '');

const message = (e: unknown) => storable(e instanceof Error ? e.message : String(e)).slice(0, 500);

/** A refusal (403, 404, 409…) will be the same next time: the event fails for good. */
function finalReason(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const status = e.getStatus();
  if (status < 400 || status >= 500 || status === 408 || status === 429) return null;
  const body = e.getResponse() as { reason?: string; message?: string; rule?: string } | string;
  if (typeof body === 'string') return storable(body).slice(0, 500);
  return storable(
    [body.rule, body.reason ?? body.message ?? e.message].filter(Boolean).join(': '),
  ).slice(0, 500);
}

const notFound = () => new NotFoundException({ error: 'not_found', message: 'No such webhook' });

/** An event for an account no connection holds is forgotten after this long. */
const UNROUTED_KEEP_MS = 30 * 86_400_000;
/** A grant that does not refresh: its managers are told this long before it ends. */
const EXPIRY_NOTICE_MS = 7 * 86_400_000;

/**
 * The key each event is stored under. A signed id is its own key. An id the connector cannot
 * vouch for is kept only as the sender's word: whoever saw the request could post it again
 * under a fresh one, so the event is keyed by the signed body (and its place in a batch).
 */
function keysOf(
  events: readonly InboundEvent[],
  rawBody: Buffer,
  signedIds: boolean | undefined,
): { key: string; senderId: string | null }[] {
  if (signedIds) return events.map((e) => ({ key: e.id, senderId: null }));
  return events.map((e, i) => {
    const key = bodyKey(rawBody, events.length > 1 ? i : undefined);
    return { key, senderId: e.id === key ? null : e.id };
  });
}

/**
 * Inbound webhooks: `/webhooks/<connector>/<connection>`. The request is verified with the
 * connection's own credentials, each event is stored once (by its signed id, or by the signed
 * body when its id is not signed) and queued, and in the worker each handler that takes it runs
 * as the business's system principal.
 */
@Injectable()
export class InboundService implements OnApplicationBootstrap {
  private readonly ctx: ServerContext;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JOBS) private readonly jobs: Jobs,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModuleRef) ref: ModuleRef,
  ) {
    this.ctx = serverContext(ref);
  }

  /** Every handler names a registered connector and known capabilities. */
  onApplicationBootstrap() {
    for (const h of connectorHandlers.all()) {
      if (!connectors.has(h.connector))
        throw new Error(
          `Handler ${h.name} takes events from ${h.connector}, which is not a registered connector`,
        );
      const unknown = (h.capabilities ?? []).find((c) => !capabilityRegistry.has(c));
      if (unknown)
        throw new Error(`Handler ${h.name} names capability "${unknown}", which nobody defines`);
    }
  }

  /** The connector and the connection's credentials, or 404/401 without saying which. */
  private async open(connectorName: string, connectionId: string) {
    const connector = connectors.get(connectorName);
    if (!connector?.inbound?.verify || !UUID.test(connectionId)) throw notFound();
    // Without a key nothing can be verified: the sender retries later.
    requireSecretBox();
    const [row] = await this.db
      .select({ tenantId: integrationConnections.tenantId })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.id, connectionId),
          eq(integrationConnections.connector, connector.name),
          eq(integrationConnections.status, 'active'),
        ),
      );
    if (!row) throw notFound();
    const opened = await openConnection(this.db, row.tenantId, connectionId);
    // A sealed value that does not open here (copied from another row) verifies nothing.
    if (!opened) throw new UnauthorizedException('bad signature');
    const creds = connector.credentials.safeParse(opened.credentials);
    if (!creds.success) throw new UnauthorizedException('bad signature');
    const { verify, parse } = connector.inbound;
    if (!parse) throw notFound();
    return {
      connector,
      inbound: { ...connector.inbound, verify, parse },
      connection: opened.row,
      credentials: creds.data,
    };
  }

  /**
   * POST: verify, store each event once, queue it. Answers fast: senders retry slow ones. A
   * connector's handshake (Graph's `?validationToken=`) is answered with its text instead, and
   * nothing is stored.
   */
  async receive(
    connectorName: string,
    connectionId: string,
    req: InboundRequest,
  ): Promise<{ stored: number } | { handshake: string }> {
    const { inbound, connection, credentials } = await this.open(connectorName, connectionId);
    const handshake = inbound.handshake?.(req, credentials) ?? null;
    if (handshake !== null) return { handshake };
    // A sender that posts headers only (a push channel) says so; any other needs a body to sign.
    if ((!req.rawBody?.length && !inbound.bodyless) || !inbound.verify(req, credentials))
      throw new UnauthorizedException('bad signature');
    let events: InboundEvent[];
    try {
      events = inbound.parse(req, credentials).map(checkEvent);
    } catch (e) {
      throw new BadRequestException({ error: 'unreadable', message: message(e) });
    }
    const keys = keysOf(events, req.rawBody ?? Buffer.alloc(0), inbound.signedIds);
    let stored = 0;
    for (const [i, event] of events.entries()) {
      const { key, senderId } = keys[i];
      const [row] = await this.db
        .insert(integrationInbound)
        .values({
          tenantId: connection.tenantId,
          connectionId: connection.id,
          connector: connection.connector,
          externalId: key,
          senderId,
          type: event.type,
          data: event.data as never,
          queues: config.queuePrefix,
        })
        .onConflictDoNothing()
        .returning({ id: integrationInbound.id });
      if (!row) {
        log.log(`duplicate ${connection.connector} event ${key}: ignored`);
        continue;
      }
      stored++;
      await this.jobs.add<InboundJob>(
        INBOUND_QUEUE,
        { inboundId: row.id },
        { name: 'inbound', jobId: `inbound--${row.id}` },
      );
    }
    return { stored };
  }

  /* ── One URL for a provider (decisions B24) ─────────────────────────────── */

  /** Does this connector take a provider's shared URL (`/webhooks/<name>`)? */
  isShared(connectorName: string): boolean {
    const c = connectors.get(connectorName);
    return !!c?.inbound?.shared && isOAuthConnector(c);
  }

  private shared(connectorName: string) {
    const c = connectors.get(connectorName);
    const shared = c?.inbound?.shared;
    if (!c || !shared || !isOAuthConnector(c)) throw notFound();
    // Without the app's secret nothing can be verified: the provider retries later.
    const app = sharedApp(c);
    if (!app) throw notFound();
    return { connector: c, shared, app, signedIds: c.inbound?.signedIds };
  }

  /**
   * POST /webhooks/<connector>: verified once with the app's secret, then each event goes to the
   * connection holding the account it names: an account a sign-in found in the provider's own
   * answer, held by one connection at most. An event for an account nobody holds is kept by its
   * key only (no content: it belongs to no business) and logged. A connection that needs signing
   * in again keeps its events, unqueued, until it is signed in.
   */
  async receiveShared(connectorName: string, req: InboundRequest) {
    const { connector, shared, app, signedIds } = this.shared(connectorName);
    if (!req.rawBody?.length || !shared.verify(req, app))
      throw new UnauthorizedException('bad signature');
    let events: InboundEvent[];
    let accounts: string[];
    try {
      events = shared.parse(req, app).map(checkEvent);
      accounts = events.map((e) => {
        const account = shared.accountOf(e);
        if (typeof account !== 'string' || !account || account.length > 200)
          throw new Error('An event names no account');
        return account;
      });
    } catch (e) {
      throw new BadRequestException({ error: 'unreadable', message: message(e) });
    }
    const keys = keysOf(events, req.rawBody, signedIds);
    const holders = accounts.length
      ? await this.db
          .select({
            accountId: integrationAccounts.accountId,
            connectionId: integrationConnections.id,
            tenantId: integrationConnections.tenantId,
            status: integrationConnections.status,
          })
          .from(integrationAccounts)
          .innerJoin(
            integrationConnections,
            eq(integrationConnections.id, integrationAccounts.connectionId),
          )
          .where(
            and(
              eq(integrationAccounts.connector, connector.name),
              eq(integrationAccounts.held, true),
              inArray(integrationAccounts.accountId, [...new Set(accounts)]),
            ),
          )
      : [];
    const holder = new Map(holders.map((h) => [h.accountId, h]));
    let stored = 0;
    let unrouted = 0;
    for (const [i, event] of events.entries()) {
      const { key, senderId } = keys[i];
      const to = holder.get(accounts[i]);
      if (!to || to.status === 'disabled') {
        const [kept] = await this.db
          .insert(integrationUnrouted)
          .values({
            connector: connector.name,
            accountId: accounts[i],
            externalId: key,
            type: event.type,
          })
          .onConflictDoNothing()
          .returning({ id: integrationUnrouted.id });
        if (kept) {
          unrouted++;
          log.warn(
            `${connector.name} event ${key} for account ${accounts[i]}: no connection holds it`,
          );
        }
        continue;
      }
      const [row] = await this.db
        .insert(integrationInbound)
        .values({
          tenantId: to.tenantId,
          connectionId: to.connectionId,
          connector: connector.name,
          externalId: key,
          senderId,
          type: event.type,
          data: event.data as never,
          accountId: accounts[i],
          queues: config.queuePrefix,
        })
        .onConflictDoNothing()
        .returning({ id: integrationInbound.id });
      if (!row) {
        log.log(`duplicate ${connector.name} event ${key}: ignored`);
        continue;
      }
      stored++;
      // Kept for when it is signed in again: the sweep queues it then.
      if (to.status !== 'active') continue;
      await this.jobs.add<InboundJob>(
        INBOUND_QUEUE,
        { inboundId: row.id },
        { name: 'inbound', jobId: `inbound--${row.id}` },
      );
    }
    return { stored, unrouted };
  }

  /** GET /webhooks/<connector>: the provider's subscription check, or 403. */
  async challengeShared(connectorName: string, req: InboundRequest) {
    const { shared, app } = this.shared(connectorName);
    return shared.challenge?.(req, app) ?? null;
  }

  /**
   * With the deliveries' sweep, every minute: stored events of this queue prefix still pending a
   * minute after they came in get their job again (the job id is the same, so one that is only
   * waiting is not added twice). A redelivery of a stored event is ignored, so this is what
   * recovers one whose job was never added.
   */
  async sweep(): Promise<number> {
    // A connection that needs signing in again keeps its events until it is (decisions B24).
    const due = await this.db
      .select({ id: integrationInbound.id })
      .from(integrationInbound)
      .innerJoin(
        integrationConnections,
        eq(integrationConnections.id, integrationInbound.connectionId),
      )
      .where(
        and(
          eq(integrationInbound.queues, config.queuePrefix),
          eq(integrationInbound.status, 'pending'),
          eq(integrationConnections.status, 'active'),
          sql`${integrationInbound.receivedAt} < now() - interval '1 minute'`,
        ),
      )
      .limit(500);
    await this.housekeeping();
    for (const { id } of due)
      await this.jobs.add<InboundJob>(
        INBOUND_QUEUE,
        { inboundId: id },
        { name: 'inbound', jobId: `inbound--${id}` },
      );
    return due.length;
  }

  /**
   * Every minute too: sign-ins nobody can finish, unrouted events past their 30 days, and the
   * grants that do not refresh: told a week before they end, marked when they have.
   */
  private async housekeeping() {
    await forgetOldSignIns(this.db);
    await this.db
      .delete(integrationUnrouted)
      .where(lt(integrationUnrouted.receivedAt, new Date(Date.now() - UNROUTED_KEEP_MS)));
    const lasting = connectors
      .all()
      .filter((c) => isOAuthConnector(c) && c.oauth.refresh === false)
      .map((c) => c.name);
    if (!lasting.length) return;
    const ending = await this.db
      .select()
      .from(integrationConnections)
      .where(
        and(
          inArray(integrationConnections.connector, lasting),
          eq(integrationConnections.auth, 'oauth'),
          eq(integrationConnections.status, 'active'),
          isNotNull(integrationConnections.tokenExpiresAt),
          lte(integrationConnections.tokenExpiresAt, new Date(Date.now() + EXPIRY_NOTICE_MS)),
        ),
      )
      .limit(200);
    for (const row of ending) {
      if ((row.tokenExpiresAt as Date) <= new Date()) {
        await markNeedsReauth(this.db, row, 'The grant expired: sign the connection in again');
        continue;
      }
      if (row.expiryNoticeAt) continue;
      await this.db.transaction(async (tx) => {
        const [noted] = await tx
          .update(integrationConnections)
          .set({ expiryNoticeAt: new Date() })
          .where(
            and(
              eq(integrationConnections.id, row.id),
              isNull(integrationConnections.expiryNoticeAt),
            ),
          )
          .returning({ id: integrationConnections.id });
        if (!noted) return;
        await recordEvents(tx, {
          principal: systemPrincipal({ tenantId: row.tenantId, job: 'integrations.oauth' }),
          events: [
            new IntegrationEvent('connection.reauth_soon', {
              id: row.id,
              tenantId: row.tenantId,
              connector: row.connector,
              label: row.label ?? row.connector,
              expiresAt: (row.tokenExpiresAt as Date).toISOString(),
            }),
          ],
        });
      });
    }
  }

  /** GET: a connector's subscription check, or 403. */
  async challenge(connectorName: string, connectionId: string, req: InboundRequest) {
    const { inbound, credentials } = await this.open(connectorName, connectionId);
    const answer = inbound.challenge?.(req, credentials) ?? null;
    return answer;
  }

  /**
   * One stored event, in the worker: each handler that takes it and has not finished runs once
   * more. `lastTry`: the queue will not try again, so an error now is final.
   */
  async process(inboundId: string, lastTry: boolean): Promise<string> {
    const [row] = await this.db
      .update(integrationInbound)
      .set({ status: 'processing', attempts: sql`${integrationInbound.attempts} + 1` })
      .where(
        and(
          eq(integrationInbound.id, inboundId),
          eq(integrationInbound.queues, config.queuePrefix),
          sql`${integrationInbound.status} in ('pending', 'processing')`,
        ),
      )
      .returning();
    if (!row) return 'not pending';
    const [connection] = await this.db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.id, row.connectionId),
          eq(integrationConnections.tenantId, row.tenantId),
        ),
      );
    if (!connection) {
      await this.close(row.id, { status: 'failed', error: 'The connection is gone' });
      return 'failed';
    }
    let { type, data } = row;
    try {
      const expanded = await this.expand(row, connection);
      if (expanded) ({ type, data } = expanded);
    } catch (e) {
      if (isNeedsReauth(e)) return this.hold(row.id, row.handled as Record<string, string>);
      if (!lastTry) {
        await this.db
          .update(integrationInbound)
          .set({ error: `expand: ${message(e)}` })
          .where(eq(integrationInbound.id, row.id));
        throw e;
      }
      await this.close(row.id, { status: 'failed', error: `expand: ${message(e)}` });
      return 'failed';
    }
    const handlers = handlersFor(row.connector, type);
    if (!handlers.length) {
      await this.close(row.id, { status: 'ignored', error: null });
      return 'ignored';
    }

    const handled = { ...(row.handled as Record<string, string>) };
    const event: InboundEventRecord = {
      id: row.id,
      tenantId: row.tenantId,
      connectionId: row.connectionId,
      connector: row.connector,
      externalId: row.externalId,
      senderId: row.senderId,
      type,
      data,
      receivedAt: row.receivedAt.toISOString(),
    };
    const failures: string[] = [];
    for (const handler of handlers) {
      if (handled[handler.name] === 'done' || handled[handler.name]?.startsWith('failed')) continue;
      try {
        await handler.handle(event, this.contextFor(handler, event, connection));
        handled[handler.name] = 'done';
      } catch (e) {
        // The connection needs signing in again: the event waits for it, as it stands.
        if (isNeedsReauth(e)) return this.hold(row.id, handled);
        const reason = finalReason(e);
        if (reason === null && !lastTry) {
          // Kept for the next try: what finished stays finished.
          await this.db
            .update(integrationInbound)
            .set({ handled, error: `${handler.name}: ${message(e)}` })
            .where(eq(integrationInbound.id, row.id));
          throw e;
        }
        handled[handler.name] = `failed: ${reason ?? message(e)}`;
        failures.push(`${handler.name}: ${reason ?? message(e)}`);
      }
    }
    await this.close(row.id, {
      status: failures.length ? 'failed' : 'processed',
      error: failures.length ? failures.join('; ').slice(0, 1000) : null,
      handled,
    });
    return failures.length ? 'failed' : 'processed';
  }

  /**
   * The event in full, once: the connector's `expand` (a notice that names a lead, fetched as
   * the lead), stored in place of what came in. Undefined when the connector has none, or it
   * already ran (a retry, after a handler failed).
   */
  private async expand(
    row: typeof integrationInbound.$inferSelect,
    connection: typeof integrationConnections.$inferSelect,
  ) {
    const expand = connectors.get(row.connector)?.inbound?.expand;
    if (!expand || row.expandedAt) return undefined;
    const out = checkEvent(
      await expand(
        { id: row.externalId, type: row.type, data: row.data },
        {
          account: row.accountId,
          call: (init) =>
            connectorRequest(
              this.db,
              { tenantId: row.tenantId, connectionId: connection.id },
              init,
            ),
        },
      ),
    );
    await this.db
      .update(integrationInbound)
      .set({ type: out.type, data: out.data as never, expandedAt: new Date() })
      .where(eq(integrationInbound.id, row.id));
    return { type: out.type, data: out.data };
  }

  /** Back to pending, unqueued: the sweep queues it once its connection is signed in again. */
  private async hold(id: string, handled: Record<string, string>) {
    await this.db
      .update(integrationInbound)
      .set({ status: 'pending', handled, error: 'The connection needs signing in again' })
      .where(eq(integrationInbound.id, id));
    return 'held';
  }

  private async close(
    id: string,
    set: { status: string; error: string | null; handled?: Record<string, string> },
  ) {
    await this.db
      .update(integrationInbound)
      .set({ ...set, processedAt: new Date() })
      .where(eq(integrationInbound.id, id));
  }

  /** The business's system principal, and writes through runWrite keyed to this event. */
  private contextFor(
    handler: ConnectorHandler,
    event: InboundEventRecord,
    connection: typeof integrationConnections.$inferSelect,
  ): ConnectorHandlerContext {
    const principal = systemPrincipal({
      tenantId: event.tenantId,
      job: `integrations.${event.connector}`,
      runId: event.id,
      capabilities: handler.capabilities ?? [],
    });
    let n = 0;
    return {
      get: (token) => this.ctx.get(token),
      db: this.db,
      jobs: this.jobs,
      principal,
      connection: {
        id: connection.id,
        connector: connection.connector,
        label: connection.label,
        public: connection.public as Record<string, unknown>,
      },
      // biome-ignore lint/suspicious/noExplicitAny: any operation
      write: async (op: WriteOp<any, any, any>, input: unknown): Promise<WriteResult> => {
        n += 1;
        const out = await runWrite(
          this.db,
          {
            principal,
            requestId: `inbound-${event.id}`,
            idempotencyKey: `inbound:${event.id}:${handler.name}:${n}`,
          },
          op,
          input,
        );
        for (const e of out.events) this.events.publish(e);
        return out.result;
      },
      credentials: async <C>() => {
        const opened = await openConnection<C>(this.db, event.tenantId, connection.id);
        if (!opened) throw new Error('The connection’s credentials do not open');
        return opened.credentials;
      },
      accessToken: async (account?: string) => {
        const [row] = await this.db
          .select()
          .from(integrationConnections)
          .where(eq(integrationConnections.id, connection.id));
        if (!row) throw new Error('The connection is gone');
        return (
          (account ? await accountTokenFor(this.db, row, account) : null) ??
          (await accessTokenFor(this.db, row))
        );
      },
      request: (init) =>
        connectorRequest(this.db, { tenantId: event.tenantId, connectionId: connection.id }, init),
    };
  }
}
