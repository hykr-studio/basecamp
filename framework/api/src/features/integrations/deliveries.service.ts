import {
  type EgressResponse,
  isEgressBlocked,
  SecretBoxError,
  safeRequest,
  signWebhook,
} from '@hykr/connectors';
import { capabilities, type DomainEventEnvelope } from '@hykr/contracts';
import { systemPrincipal } from '@hykr/core';
import {
  type Database,
  integrationAttempts,
  integrationDeliveries,
  integrationEndpoints,
} from '@hykr/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import type { Jobs } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { matchesEvent } from '../events/subscriber.js';
import type { EndpointRow } from './ops.js';
import { buildBody } from './payload.js';
import { endpointAad, outboundPolicy, retrySchedule, secretBox } from './settings.js';

const log = new Logger('Webhooks');

export const DELIVER_QUEUE = 'integrations.deliver';
/** The sweeper's job name on the deliver queue. */
export const SWEEP = 'integrations.sweep';

/** One try of one delivery: the job claims the delivery only at this attempt. */
export type DeliverJob = { deliveryId: string; attempt: number };

/** How long a delivery that is being sent is held, beyond the request's own timeout. */
const LEASE_GRACE_MS = 30_000;
/** A due delivery whose job has not run this long after is given a new one. */
const SWEEP_GRACE_MS = 30_000;
/** What the attempt log keeps of an answer. */
const RESPONSE_CHARS = 512;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** BullMQ ids may not contain ':'. */
const jobId = (...parts: (string | number)[]) => parts.join('--').replaceAll(':', '_');

/** The principal an endpoint reads as: its business, and only the capabilities it was given. */
export const endpointPrincipal = (e: Pick<EndpointRow, 'tenantId' | 'capabilities' | 'id'>) =>
  systemPrincipal({
    tenantId: e.tenantId,
    job: 'integrations.webhooks',
    // A capability removed since the endpoint got it grants nothing.
    capabilities: e.capabilities.filter((c) => capabilities.has(c)),
  });

/**
 * Outbound webhooks: one delivery per event and matching endpoint, signed and sent through the
 * egress guard, retried on a schedule, every try logged.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JOBS) private readonly jobs: Jobs,
  ) {}

  /**
   * An event, as the `integrations.webhooks` subscriber gets it: a delivery for each active
   * endpoint of its business that wants it and may read its record. Unique per endpoint and
   * event, so an event relayed twice is one delivery.
   */
  async fanOut(event: DomainEventEnvelope): Promise<number> {
    const endpoints = await this.db
      .select()
      .from(integrationEndpoints)
      .where(
        and(
          eq(integrationEndpoints.tenantId, event.tenantId),
          eq(integrationEndpoints.status, 'active'),
        ),
      );
    let made = 0;
    for (const endpoint of endpoints) {
      if (!endpoint.events.some((p) => matchesEvent(p, event.name))) continue;
      const body = buildBody(event, endpointPrincipal(endpoint));
      if (body === null) continue;
      const [row] = await this.db
        .insert(integrationDeliveries)
        .values({
          tenantId: event.tenantId,
          endpointId: endpoint.id,
          eventId: event.id,
          eventName: event.name,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          body,
          status: 'pending',
          nextAttemptAt: new Date(),
          queues: config.queuePrefix,
        })
        .onConflictDoNothing()
        .returning({ id: integrationDeliveries.id });
      if (!row) continue;
      made++;
      await this.enqueue(row.id, 1);
    }
    return made;
  }

  private enqueue(deliveryId: string, attempt: number, delay = 0, tag = 'run') {
    return this.jobs.add<DeliverJob>(
      DELIVER_QUEUE,
      { deliveryId, attempt },
      { name: 'deliver', jobId: jobId('delivery', deliveryId, attempt, tag), delay },
    );
  }

  /** A retry asked for by a person: one more try now, whatever was scheduled. */
  async retryNow(delivery: { id: string; attempts: number }) {
    await this.enqueue(delivery.id, delivery.attempts + 1, 0, `now-${Date.now()}`);
  }

  /**
   * One try. The delivery is claimed only if this is its next attempt and nobody holds it (or
   * whoever held it let the lease run out), so a duplicate job sends nothing.
   */
  async attempt({ deliveryId, attempt }: DeliverJob): Promise<string> {
    const policy = outboundPolicy();
    const leaseMs = (policy.timeoutMs ?? 10_000) + LEASE_GRACE_MS;
    const [d] = await this.db
      .update(integrationDeliveries)
      .set({
        status: 'sending',
        leaseUntil: sql`now() + ${`${leaseMs} milliseconds`}::interval`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationDeliveries.id, deliveryId),
          eq(integrationDeliveries.queues, config.queuePrefix),
          eq(integrationDeliveries.attempts, attempt - 1),
          or(
            inArray(integrationDeliveries.status, ['pending', 'retrying']),
            and(
              eq(integrationDeliveries.status, 'sending'),
              lt(integrationDeliveries.leaseUntil, sql`now()`),
            ),
          ),
        ),
      )
      .returning();
    if (!d) return 'not due';

    const [endpoint] = await this.db
      .select()
      .from(integrationEndpoints)
      .where(
        and(
          eq(integrationEndpoints.id, d.endpointId),
          eq(integrationEndpoints.tenantId, d.tenantId),
        ),
      );
    if (endpoint?.status !== 'active') {
      await this.finish(d.id, { status: 'cancelled', lastError: 'The endpoint is paused' });
      return 'cancelled';
    }

    const started = Date.now();
    let res: EgressResponse | undefined;
    let error: string | undefined;
    let final = false;
    try {
      const secrets = this.secretsOf(endpoint);
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'Basecamp-Webhooks/1',
        ...signWebhook({ secrets, id: d.id, body: d.body }),
      };
      res = await safeRequest(endpoint.url, { method: 'POST', headers, body: d.body }, policy);
      if (res.status < 200 || res.status >= 300) error = `The receiver answered ${res.status}`;
    } catch (e) {
      error = message(e);
      // An address the guard refuses will not become public by waiting.
      final = isEgressBlocked(e);
    }

    await this.db.insert(integrationAttempts).values({
      tenantId: d.tenantId,
      deliveryId: d.id,
      attempt,
      url: endpoint.url,
      status: res?.status ?? null,
      error: error ?? null,
      durationMs: res?.durationMs ?? Date.now() - started,
      response: res ? res.body.slice(0, RESPONSE_CHARS) : null,
    });

    if (!error) {
      await this.finish(d.id, {
        status: 'delivered',
        attempts: attempt,
        lastStatus: res?.status ?? null,
        lastError: null,
        deliveredAt: new Date(),
        nextAttemptAt: null,
      });
      return 'delivered';
    }
    const schedule = retrySchedule();
    const wait = final ? undefined : schedule[attempt - 1];
    if (wait === undefined) {
      await this.finish(d.id, {
        status: 'failed',
        attempts: attempt,
        lastStatus: res?.status ?? null,
        lastError: error,
        nextAttemptAt: null,
      });
      log.warn(`delivery ${d.id} failed for good after ${attempt} tries: ${error}`);
      return 'failed';
    }
    await this.finish(d.id, {
      status: 'retrying',
      attempts: attempt,
      lastStatus: res?.status ?? null,
      lastError: error,
      nextAttemptAt: new Date(Date.now() + wait),
    });
    await this.enqueue(d.id, attempt + 1, wait);
    return 'retrying';
  }

  /** The secrets that sign now: the current one, and the previous during its overlap. */
  private secretsOf(endpoint: EndpointRow): string[] {
    const box = secretBox();
    if (!box) throw new Error('This server has no SECRETS_KEY: the request cannot be signed');
    const aad = endpointAad(endpoint.tenantId, endpoint.id);
    try {
      const secrets = [box.open(endpoint.secretSealed, aad)];
      if (
        endpoint.previousSecretSealed &&
        endpoint.previousExpiresAt &&
        endpoint.previousExpiresAt > new Date()
      )
        secrets.push(box.open(endpoint.previousSecretSealed, aad));
      return secrets;
    } catch (e) {
      if (e instanceof SecretBoxError)
        throw new Error(`The signing secret does not open: ${e.message}`);
      throw e;
    }
  }

  private async finish(
    id: string,
    set: Partial<typeof integrationDeliveries.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(integrationDeliveries)
      .set({ ...set, leaseUntil: null, updatedAt: new Date() })
      .where(eq(integrationDeliveries.id, id));
  }

  /**
   * Every minute: deliveries of this queue prefix that are due but whose job was lost (a crash
   * between the commit and the add, a worker that died mid-send) get a job again.
   */
  async sweep(): Promise<number> {
    const due = await this.db
      .select({ id: integrationDeliveries.id, attempts: integrationDeliveries.attempts })
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.queues, config.queuePrefix),
          or(
            and(
              inArray(integrationDeliveries.status, ['pending', 'retrying']),
              lte(
                integrationDeliveries.nextAttemptAt,
                sql`now() - ${`${SWEEP_GRACE_MS} milliseconds`}::interval`,
              ),
            ),
            and(
              eq(integrationDeliveries.status, 'sending'),
              lt(integrationDeliveries.leaseUntil, sql`now()`),
            ),
          ),
        ),
      )
      .limit(500);
    const minute = Math.floor(Date.now() / 60_000);
    for (const d of due) await this.enqueue(d.id, d.attempts + 1, 0, `sweep-${minute}`);
    return due.length;
  }
}
