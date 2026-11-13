import { randomUUID } from 'node:crypto';
import { type Connector, generateWebhookSecret } from '@hykr/connectors';
import type { Principal } from '@hykr/contracts';
import { requireCapability, runWrite, type WriteOp } from '@hykr/core';
import {
  type Database,
  integrationAttempts,
  integrationConnections,
  integrationDeliveries,
  integrationEndpoints,
  integrationInbound,
} from '@hykr/db';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import type { z } from 'zod';
import { DB } from '../../infra/db.module.js';
import { storableInstant } from '../../infra/instant.js';
import { IntegrationsCapability } from './capability.js';
import { DeliveriesService } from './deliveries.service.js';
import {
  ConnectionCreate,
  ConnectionUpdate,
  connectionView,
  createConnectionOp,
  createEndpointOp,
  deleteConnectionOp,
  deleteEndpointOp,
  deliveryView,
  EndpointCreate,
  EndpointUpdate,
  endpointView,
  registerIntegrationOps,
  retryDeliveryOp,
  rotateEndpointOp,
  updateConnectionOp,
  updateEndpointOp,
} from './ops.js';
import { projectPayload } from './payload.js';
import { connectors } from './registry.js';
import {
  checkSettings,
  connectionAad,
  endpointAad,
  PREVIOUS_SECRET_MS,
  requireSecretBox,
} from './settings.js';

/** What a request sends, checked, or 400 with the problems. */
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success)
    throw new BadRequestException({
      error: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return parsed.data;
}

const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

const LOG_LIMIT = 50;

/**
 * Endpoints, connections and their logs, for people with `integrations.manage` in their
 * business. Writes go through runWrite (ops.ts); reads check the capability and the business.
 */
@Injectable()
export class IntegrationsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(EventBus) private readonly events: EventBus,
    private readonly deliveriesService: DeliveriesService,
  ) {}

  onModuleInit() {
    checkSettings();
    registerIntegrationOps();
  }

  private read(p: Principal) {
    requireCapability(p, IntegrationsCapability, {
      rule: 'integrations_manage_needed',
      reason: 'Only people who manage integrations can see them',
    });
    return p.tenantId ?? '';
  }

  // biome-ignore lint/suspicious/noExplicitAny: any of the feature's ops
  private async write(p: Principal, requestId: string, op: WriteOp<any, any, any>, input: unknown) {
    const out = await runWrite(this.db, { principal: p, requestId }, op, input);
    for (const event of out.events) this.events.publish(event);
    return out.result;
  }

  /* ── Connectors ─────────────────────────────────────────────────────────── */

  listConnectors(p: Principal) {
    this.read(p);
    return connectors.all().map((c) => ({
      name: c.name,
      label: c.label,
      ...(c.description ? { description: c.description } : {}),
      inbound: c.inbound !== undefined,
      generates: c.generate !== undefined,
      publicFields: c.publicFields ?? [],
    }));
  }

  /* ── Endpoints ──────────────────────────────────────────────────────────── */

  async listEndpoints(p: Principal) {
    const tenantId = this.read(p);
    const rows = await this.db
      .select()
      .from(integrationEndpoints)
      .where(eq(integrationEndpoints.tenantId, tenantId))
      .orderBy(asc(integrationEndpoints.createdAt));
    return rows.map(endpointView);
  }

  async getEndpoint(p: Principal, id: string) {
    return endpointView(await this.endpointRow(this.read(p), id));
  }

  private async endpointRow(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(integrationEndpoints)
      .where(and(eq(integrationEndpoints.id, id), eq(integrationEndpoints.tenantId, tenantId)));
    if (!row) throw notFound('endpoint');
    return row;
  }

  /** The secret is generated here, sealed into the op's input, and returned once. */
  async createEndpoint(p: Principal, requestId: string, body: unknown) {
    const input = parse(EndpointCreate, body);
    const box = requireSecretBox();
    const id = randomUUID();
    const secret = generateWebhookSecret();
    const sealed = box.seal(secret, endpointAad(p.tenantId ?? '', id));
    const result = await this.write(p, requestId, createEndpointOp(), { ...input, id, sealed });
    return { ...result, secret };
  }

  async updateEndpoint(p: Principal, requestId: string, id: string, body: unknown) {
    return this.write(p, requestId, updateEndpointOp({ id }), parse(EndpointUpdate, body));
  }

  async deleteEndpoint(p: Principal, requestId: string, id: string) {
    return this.write(p, requestId, deleteEndpointOp({ id }), {});
  }

  /** A new secret; the old one keeps signing for a day, so receivers can switch over. */
  async rotateEndpoint(p: Principal, requestId: string, id: string) {
    const box = requireSecretBox();
    const secret = generateWebhookSecret();
    const sealed = box.seal(secret, endpointAad(p.tenantId ?? '', id));
    const result = await this.write(p, requestId, rotateEndpointOp({ id }, PREVIOUS_SECRET_MS), {
      sealed,
    });
    return { ...result, secret };
  }

  /** The newest deliveries first; `before` (a time) pages back. */
  async deliveries(
    p: Principal,
    endpointId: string,
    query: { status?: string; before?: string; limit?: string },
  ) {
    const tenantId = this.read(p);
    await this.endpointRow(tenantId, endpointId);
    const limit = Math.min(Math.max(Number(query.limit ?? LOG_LIMIT) || LOG_LIMIT, 1), 200);
    const before = query.before ? storableInstant(query.before) : undefined;
    if (query.before && !before)
      throw new BadRequestException({ error: 'invalid', message: 'before is not a time' });
    const rows = await this.db
      .select()
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.tenantId, tenantId),
          eq(integrationDeliveries.endpointId, endpointId),
          query.status ? eq(integrationDeliveries.status, query.status) : undefined,
          before ? lt(integrationDeliveries.createdAt, before) : undefined,
        ),
      )
      .orderBy(desc(integrationDeliveries.createdAt), desc(integrationDeliveries.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(deliveryView);
    return { items, nextBefore: rows.length > limit ? (items.at(-1)?.createdAt ?? null) : null };
  }

  /** One more try now (a delivered one is sent again, with the same webhook-id). */
  async retryDelivery(p: Principal, requestId: string, id: string) {
    const result = await this.write(p, requestId, retryDeliveryOp({ id }), {});
    if (result.status === 'done')
      await this.deliveriesService.retryNow(result.value as { id: string; attempts: number });
    return result;
  }

  /** One delivery: its payload as this reader may see it, and every try. */
  async delivery(p: Principal, id: string) {
    const tenantId = this.read(p);
    const [row] = await this.db
      .select()
      .from(integrationDeliveries)
      .where(and(eq(integrationDeliveries.id, id), eq(integrationDeliveries.tenantId, tenantId)));
    if (!row) throw notFound('delivery');
    const attempts = await this.db
      .select()
      .from(integrationAttempts)
      .where(eq(integrationAttempts.deliveryId, row.id))
      .orderBy(asc(integrationAttempts.attempt), asc(integrationAttempts.createdAt));
    return {
      ...deliveryView(row),
      payload: projectPayload(row.body, row.resourceType, p),
      attempts: attempts.map((a) => ({
        attempt: a.attempt,
        url: a.url,
        status: a.status,
        error: a.error,
        durationMs: a.durationMs,
        response: a.response,
        at: a.createdAt.toISOString(),
      })),
    };
  }

  /* ── Connections ────────────────────────────────────────────────────────── */

  private connector(name: string): Connector<unknown> {
    const c = connectors.get(name);
    if (!c) throw new BadRequestException({ error: 'invalid', message: `No connector ${name}` });
    return c;
  }

  /** The connector's credentials, checked; its public fields apart. */
  private credentialsFor(c: Connector<unknown>, raw: unknown) {
    const parsed = c.credentials.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException({
        error: 'invalid',
        message: `Credentials for ${c.name}`,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const value = parsed.data as Record<string, unknown>;
    const pub = Object.fromEntries(
      (c.publicFields ?? []).flatMap((f) => (f in value ? [[f, value[f]]] : [])),
    );
    return { value, public: pub };
  }

  async listConnections(p: Principal) {
    const tenantId = this.read(p);
    const rows = await this.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.tenantId, tenantId))
      .orderBy(asc(integrationConnections.createdAt));
    return rows.map(connectionView);
  }

  async getConnection(p: Principal, id: string) {
    return connectionView(await this.connectionRow(this.read(p), id));
  }

  private async connectionRow(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.id, id), eq(integrationConnections.tenantId, tenantId)));
    if (!row) throw notFound('connection');
    return row;
  }

  /**
   * A connection: the credentials given, or ones the connector makes (returned once). Either
   * way they are checked against the connector's schema and sealed for the new row.
   */
  async createConnection(p: Principal, requestId: string, body: unknown) {
    const input = parse(ConnectionCreate, body);
    const c = this.connector(input.connector);
    if (!input.credentials && !c.generate)
      throw new BadRequestException({
        error: 'invalid',
        message: `${c.name} needs credentials`,
      });
    const generated = input.credentials ? undefined : c.generate?.();
    const creds = this.credentialsFor(c, input.credentials ?? generated);
    const box = requireSecretBox();
    const id = randomUUID();
    const sealed = box.seal(JSON.stringify(creds.value), connectionAad(p.tenantId ?? '', id));
    const result = await this.write(p, requestId, createConnectionOp(), {
      id,
      connector: c.name,
      ...(input.label ? { label: input.label } : {}),
      sealed,
      public: creds.public,
    });
    return generated ? { ...result, credentials: generated } : result;
  }

  async updateConnection(p: Principal, requestId: string, id: string, body: unknown) {
    const input = parse(ConnectionUpdate, body);
    const { credentials, ...rest } = input;
    if (!credentials) return this.write(p, requestId, updateConnectionOp({ id }), rest);
    // New credentials are checked against the connection's own connector, then sealed for it.
    // Whether this person may change it at all is the op's to decide (and audit).
    const row = await this.connectionRow(p.tenantId ?? '', id);
    const c = this.connector(row.connector);
    const creds = this.credentialsFor(c, credentials);
    const sealed = requireSecretBox().seal(
      JSON.stringify(creds.value),
      connectionAad(row.tenantId, row.id),
    );
    return this.write(p, requestId, updateConnectionOp({ id }), {
      ...rest,
      sealed,
      public: creds.public,
    });
  }

  async deleteConnection(p: Principal, requestId: string, id: string) {
    return this.write(p, requestId, deleteConnectionOp({ id }), {});
  }

  /** What the connection received, newest first. */
  async inbound(p: Principal, connectionId: string, query: { status?: string; limit?: string }) {
    const tenantId = this.read(p);
    await this.connectionRow(tenantId, connectionId);
    const limit = Math.min(Math.max(Number(query.limit ?? LOG_LIMIT) || LOG_LIMIT, 1), 200);
    const rows = await this.db
      .select()
      .from(integrationInbound)
      .where(
        and(
          eq(integrationInbound.tenantId, tenantId),
          eq(integrationInbound.connectionId, connectionId),
          query.status ? eq(integrationInbound.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(integrationInbound.receivedAt), desc(integrationInbound.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      externalId: r.externalId,
      senderId: r.senderId,
      type: r.type,
      data: r.data,
      status: r.status,
      attempts: r.attempts,
      handled: r.handled,
      error: r.error,
      receivedAt: r.receivedAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
    }));
  }
}
