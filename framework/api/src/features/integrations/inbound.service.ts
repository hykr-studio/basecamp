import { bodyKey, checkEvent, type InboundEvent, type InboundRequest } from '@hykr/connectors';
import { capabilities as capabilityRegistry, type WriteResult } from '@hykr/contracts';
import { runWrite, systemPrincipal, type WriteOp } from '@hykr/core';
import { type Database, integrationConnections, integrationInbound } from '@hykr/db';
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
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import type { Jobs, ServerContext } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { serverContext } from '../../queues/jobs.service.js';
import { openConnection } from './credentials.js';
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
    if (!connector?.inbound || !UUID.test(connectionId)) throw notFound();
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
    return {
      connector,
      inbound: connector.inbound,
      connection: opened.row,
      credentials: creds.data,
    };
  }

  /** POST: verify, store each event once, queue it. Answers fast: senders retry slow ones. */
  async receive(connectorName: string, connectionId: string, req: InboundRequest) {
    const { inbound, connection, credentials } = await this.open(connectorName, connectionId);
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

  /**
   * With the deliveries' sweep, every minute: stored events of this queue prefix still pending a
   * minute after they came in get their job again (the job id is the same, so one that is only
   * waiting is not added twice). A redelivery of a stored event is ignored, so this is what
   * recovers one whose job was never added.
   */
  async sweep(): Promise<number> {
    const due = await this.db
      .select({ id: integrationInbound.id })
      .from(integrationInbound)
      .where(
        and(
          eq(integrationInbound.queues, config.queuePrefix),
          eq(integrationInbound.status, 'pending'),
          sql`${integrationInbound.receivedAt} < now() - interval '1 minute'`,
        ),
      )
      .limit(500);
    for (const { id } of due)
      await this.jobs.add<InboundJob>(
        INBOUND_QUEUE,
        { inboundId: id },
        { name: 'inbound', jobId: `inbound--${id}` },
      );
    return due.length;
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
    const handlers = handlersFor(row.connector, row.type);
    if (!handlers.length) {
      await this.close(row.id, { status: 'ignored', error: null });
      return 'ignored';
    }
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

    const handled = { ...(row.handled as Record<string, string>) };
    const event: InboundEventRecord = {
      id: row.id,
      tenantId: row.tenantId,
      connectionId: row.connectionId,
      connector: row.connector,
      externalId: row.externalId,
      senderId: row.senderId,
      type: row.type,
      data: row.data,
      receivedAt: row.receivedAt.toISOString(),
    };
    const failures: string[] = [];
    for (const handler of handlers) {
      if (handled[handler.name] === 'done' || handled[handler.name]?.startsWith('failed')) continue;
      try {
        await handler.handle(event, this.contextFor(handler, event, connection));
        handled[handler.name] = 'done';
      } catch (e) {
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
    };
  }
}
