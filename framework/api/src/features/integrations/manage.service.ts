import { randomUUID } from 'node:crypto';
import { type Connector, generateWebhookSecret } from '@hykr/connectors';
import type { Principal } from '@hykr/contracts';
import {
  findRepeat,
  requireCapability,
  runWrite,
  type WriteCtx,
  type WriteOp,
  type WriteOutcome,
} from '@hykr/core';
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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { DB } from '../../infra/db.module.js';
import { storableInstant } from '../../infra/instant.js';
import { beforeOf, beforeWhere, encodeKeyset, keysetTime } from '../inbox/cursor.js';
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
  mayShowSecret,
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
  secretTag,
} from './settings.js';

/**
 * Is the record as the write being repeated left it? A secret is answered again only then: a
 * rotation, new credentials (or any other change) since means the row holds what someone else
 * wrote, which a repeat must not give away.
 */
const unchangedSince = (result: WriteOutcome['result'], row: { updatedAt: Date }) =>
  result.status === 'done' &&
  (result.value as { updatedAt?: string } | null)?.updatedAt === row.updatedAt.toISOString();

/** What a body carrying credentials is recognised by on a retry: them, tagged, never in clear. */
const recognised = <T extends { credentials?: unknown }>(input: T) =>
  input.credentials === undefined ? input : { ...input, credentials: secretTag(input.credentials) };

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

/** Who asks, and how to recognise their retry: the request's id and idempotency-key. */
export type WriteMeta = { requestId: string; idempotencyKey?: string };

// biome-ignore lint/suspicious/noExplicitAny: any of the feature's ops
type AnyOp = WriteOp<any, any, any>;

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

  /**
   * One write, honouring the caller's idempotency-key. `requestBody` is what the caller sent,
   * when the input also holds what this request made (an id, a sealed secret).
   */
  private async run(
    p: Principal,
    meta: WriteMeta,
    op: AnyOp,
    input: unknown,
    requestBody?: unknown,
  ): Promise<WriteOutcome> {
    const out = await runWrite(this.db, this.ctx(p, meta, requestBody), op, input);
    for (const event of out.events) this.events.publish(event);
    return out;
  }

  private async write(p: Principal, meta: WriteMeta, op: AnyOp, input: unknown) {
    return (await this.run(p, meta, op, input)).result;
  }

  private ctx(p: Principal, meta: WriteMeta, requestBody?: unknown): WriteCtx {
    return {
      principal: p,
      requestId: meta.requestId,
      ...(meta.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
    };
  }

  /**
   * A repeated create or rotate answers the endpoint's secret again: read from its sealed row,
   * so no secret is ever kept with the stored answer. Only while the endpoint is as that write
   * left it: after a later rotation or change, the stored answer alone.
   */
  private async withSecret(result: WriteOutcome['result'], p: Principal) {
    if (result.status !== 'done') return result;
    const id = (result.value as { id?: string } | null)?.id;
    const [row] = id
      ? await this.db
          .select()
          .from(integrationEndpoints)
          .where(
            and(
              eq(integrationEndpoints.id, id),
              eq(integrationEndpoints.tenantId, p.tenantId ?? ''),
            ),
          )
      : [];
    if (!row || !unchangedSince(result, row)) return result;
    this.mayStillSee(p, row.capabilities);
    const secret = requireSecretBox().open(row.secretSealed, endpointAad(row.tenantId, row.id));
    return { ...result, secret };
  }

  /** A secret is shown again only to whom the write would still allow (403 otherwise). */
  private mayStillSee(p: Principal, capabilities?: readonly string[]) {
    const d = mayShowSecret(p, capabilities);
    if (d.decision === 'deny')
      throw new ForbiddenException({ error: 'forbidden', rule: d.rule, reason: d.reason });
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

  /**
   * The secret is generated here, sealed into the op's input, and returned. A retry with the
   * same idempotency-key is the same endpoint, answered with its secret again.
   */
  async createEndpoint(p: Principal, meta: WriteMeta, body: unknown) {
    const input = parse(EndpointCreate, body);
    const op = createEndpointOp();
    const repeat = await findRepeat(this.db, this.ctx(p, meta), op, input);
    if (repeat) return this.withSecret(repeat.result, p);
    const box = requireSecretBox();
    const id = randomUUID();
    const secret = generateWebhookSecret();
    const sealed = box.seal(secret, endpointAad(p.tenantId ?? '', id));
    const out = await this.run(p, meta, op, { ...input, id, sealed }, input);
    // Another request with this key made it first: its secret, not this one.
    if (out.repeat) return this.withSecret(out.result, p);
    return { ...out.result, secret };
  }

  async updateEndpoint(p: Principal, meta: WriteMeta, id: string, body: unknown) {
    return this.write(p, meta, updateEndpointOp({ id }), parse(EndpointUpdate, body));
  }

  async deleteEndpoint(p: Principal, meta: WriteMeta, id: string) {
    return this.write(p, meta, deleteEndpointOp({ id }), {});
  }

  /**
   * A new secret; the old one keeps signing for a day, so receivers can switch over. A retry
   * with the same key rotates nothing again: it answers the secret the first one made.
   */
  async rotateEndpoint(p: Principal, meta: WriteMeta, id: string) {
    const op = rotateEndpointOp({ id }, PREVIOUS_SECRET_MS);
    const repeat = await findRepeat(this.db, this.ctx(p, meta), op, {});
    if (repeat) return this.withSecret(repeat.result, p);
    const box = requireSecretBox();
    const secret = generateWebhookSecret();
    const sealed = box.seal(secret, endpointAad(p.tenantId ?? '', id));
    const out = await this.run(p, meta, op, { sealed }, {});
    if (out.repeat) return this.withSecret(out.result, p);
    return { ...out.result, secret };
  }

  /**
   * The newest deliveries first; `before` pages back: the `nextBefore` a page handed out, which
   * keeps the last delivery's id beside its time (one event's deliveries share it, V12), or a time.
   */
  async deliveries(
    p: Principal,
    endpointId: string,
    query: { status?: string; before?: string; limit?: string },
  ) {
    const tenantId = this.read(p);
    await this.endpointRow(tenantId, endpointId);
    const limit = Math.min(Math.max(Number(query.limit ?? LOG_LIMIT) || LOG_LIMIT, 1), 200);
    const before = beforeOf(query.before, storableInstant);
    if (query.before && !before)
      throw new BadRequestException({ error: 'invalid', message: 'before is not a time' });
    const rows = await this.db
      .select({ row: integrationDeliveries, at: keysetTime(integrationDeliveries.createdAt) })
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.tenantId, tenantId),
          eq(integrationDeliveries.endpointId, endpointId),
          query.status ? eq(integrationDeliveries.status, query.status) : undefined,
          before
            ? beforeWhere(before, integrationDeliveries.createdAt, integrationDeliveries.id)
            : undefined,
        ),
      )
      .orderBy(desc(integrationDeliveries.createdAt), desc(integrationDeliveries.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map((r) => deliveryView(r.row));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextBefore: last ? encodeKeyset({ at: last.at, id: last.row.id }) : null };
  }

  /**
   * One more try now (a delivered one is sent again, with the same webhook-id). A retry of this
   * request with the same key tries nothing again.
   */
  async retryDelivery(p: Principal, meta: WriteMeta, id: string) {
    const { result, repeat } = await this.run(p, meta, retryDeliveryOp({ id }), {});
    if (result.status === 'done' && !repeat)
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
   * A connection: the credentials given, or ones the connector makes (returned). Either way
   * they are checked against the connector's schema and sealed for the new row. A retry with
   * the same idempotency-key is the same connection; made credentials are answered again,
   * read from its sealed row.
   */
  async createConnection(p: Principal, meta: WriteMeta, body: unknown) {
    const input = parse(ConnectionCreate, body);
    const op = createConnectionOp();
    const made = (out: WriteOutcome) =>
      input.credentials ? out.result : this.withCredentials(out.result, p);
    const request = recognised(input);
    const repeat = await findRepeat(this.db, this.ctx(p, meta), op, request);
    if (repeat) return made(repeat);
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
    const out = await this.run(
      p,
      meta,
      op,
      {
        id,
        connector: c.name,
        ...(input.label ? { label: input.label } : {}),
        sealed,
        public: creds.public,
      },
      request,
    );
    if (out.repeat) return made(out);
    return generated ? { ...out.result, credentials: generated } : out.result;
  }

  /**
   * A repeated create's made credentials, read from the connection's sealed row, while they are
   * still the ones it made: once anyone has changed the connection (new credentials, a label),
   * the stored answer alone.
   */
  private async withCredentials(result: WriteOutcome['result'], p: Principal) {
    if (result.status !== 'done') return result;
    const id = (result.value as { id?: string } | null)?.id;
    const [row] = id
      ? await this.db
          .select()
          .from(integrationConnections)
          .where(
            and(
              eq(integrationConnections.id, id),
              eq(integrationConnections.tenantId, p.tenantId ?? ''),
            ),
          )
      : [];
    if (!row || !unchangedSince(result, row)) return result;
    this.mayStillSee(p);
    const plain = requireSecretBox().open(
      row.credentialsSealed,
      connectionAad(row.tenantId, row.id),
    );
    return { ...result, credentials: JSON.parse(plain) as unknown };
  }

  async updateConnection(p: Principal, meta: WriteMeta, id: string, body: unknown) {
    const input = parse(ConnectionUpdate, body);
    const { credentials, ...rest } = input;
    const op = updateConnectionOp({ id });
    if (!credentials) return this.write(p, meta, op, rest);
    // A retry with the same key answers the first answer, even once the connection is gone:
    // look before reading the row, as a create does.
    const request = recognised(input);
    const repeat = await findRepeat(this.db, this.ctx(p, meta), op, request);
    if (repeat) return repeat.result;
    // New credentials are checked against the connection's own connector, then sealed for it.
    // Whether this person may change it at all is the op's to decide (and audit).
    const row = await this.connectionRow(p.tenantId ?? '', id);
    const c = this.connector(row.connector);
    const creds = this.credentialsFor(c, credentials);
    const sealed = requireSecretBox().seal(
      JSON.stringify(creds.value),
      connectionAad(row.tenantId, row.id),
    );
    const out = await this.run(p, meta, op, { ...rest, sealed, public: creds.public }, request);
    return out.result;
  }

  async deleteConnection(p: Principal, meta: WriteMeta, id: string) {
    return this.write(p, meta, deleteConnectionOp({ id }), {});
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
