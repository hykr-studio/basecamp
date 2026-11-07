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
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import type { Jobs } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { matchesEvent } from '../events/subscriber.js';
import type { EndpointRow } from './ops.js';
import { bodyToSend, buildBody } from './payload.js';
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
/** What one sweep takes of each kind, the longest waiting first. */
const SWEEP_LIMIT = 500;
/** The log's word for a try whose lease ran out before its result was saved. */
const UNFINISHED = 'The try did not finish (the worker stopped, or its result could not be saved)';

/** Postgres text cannot hold NUL, and a receiver's answer (or an error repeating it) may. */
const storable = (text: string) => text.replaceAll('\u0000', '');

const message = (e: unknown) => storable(e instanceof Error ? e.message : String(e)).slice(0, 500);

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
   * One try. The delivery is claimed only if this is its next try and nobody holds it, so a
   * duplicate job sends nothing. The claim counts the try: one that never finishes (a worker that
   * died, a result that could not be saved) still uses up its place in the schedule (`sweep`).
   */
  async attempt({ deliveryId, attempt }: DeliverJob): Promise<string> {
    // Read before anything is claimed or sent: a bad setting fails here, not after a send.
    const schedule = retrySchedule();
    const policy = outboundPolicy();
    const leaseMs = (policy.timeoutMs ?? 10_000) + LEASE_GRACE_MS;
    const [d] = await this.db
      .update(integrationDeliveries)
      .set({
        status: 'sending',
        attempts: attempt,
        leaseUntil: sql`now() + ${`${leaseMs} milliseconds`}::interval`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationDeliveries.id, deliveryId),
          eq(integrationDeliveries.queues, config.queuePrefix),
          eq(integrationDeliveries.attempts, attempt - 1),
          inArray(integrationDeliveries.status, ['pending', 'retrying']),
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
    // A cancelled try sends nothing, so it is not counted.
    if (endpoint?.status !== 'active') {
      await this.finish(d.id, attempt, {
        status: 'cancelled',
        attempts: attempt - 1,
        lastError: 'The endpoint is paused',
      });
      return 'cancelled';
    }

    // The endpoint reads as it is now, not as it was at fan-out: whoever changed its URL or
    // capabilities since gets no field it may no longer read, on a retry or a redelivery.
    const body = bodyToSend(d.body, d.resourceType, endpointPrincipal(endpoint));
    if (body === null) {
      await this.finish(d.id, attempt, {
        status: 'cancelled',
        attempts: attempt - 1,
        lastError: 'The record may no longer leave the platform',
      });
      return 'cancelled';
    }
    // The log keeps what was sent, so a field taken out never comes back.
    if (body !== d.body)
      await this.db
        .update(integrationDeliveries)
        .set({ body })
        .where(eq(integrationDeliveries.id, d.id));

    const started = Date.now();
    let res: EgressResponse | undefined;
    let error: string | undefined;
    let final = false;
    try {
      const secrets = this.secretsOf(endpoint);
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'Basecamp-Webhooks/1',
        ...signWebhook({ secrets, id: d.id, body }),
      };
      res = await safeRequest(endpoint.url, { method: 'POST', headers, body }, policy);
      if (res.status < 200 || res.status >= 300) error = `The receiver answered ${res.status}`;
    } catch (e) {
      error = message(e);
      // An address the guard refuses will not become public by waiting.
      final = isEgressBlocked(e);
    }

    await this.logAttempt({
      tenantId: d.tenantId,
      deliveryId: d.id,
      attempt,
      url: endpoint.url,
      status: res?.status ?? null,
      error: error ?? null,
      durationMs: res?.durationMs ?? Date.now() - started,
      response: res ? storable(res.body.slice(0, RESPONSE_CHARS)) : null,
    });

    if (!error) {
      const held = await this.finish(d.id, attempt, {
        status: 'delivered',
        lastStatus: res?.status ?? null,
        lastError: null,
        deliveredAt: new Date(),
        nextAttemptAt: null,
      });
      return held ? 'delivered' : 'taken over';
    }
    const wait = final ? undefined : schedule[attempt - 1];
    if (wait === undefined) {
      const held = await this.finish(d.id, attempt, {
        status: 'failed',
        lastStatus: res?.status ?? null,
        lastError: error,
        nextAttemptAt: null,
      });
      if (held) log.warn(`delivery ${d.id} failed for good after ${attempt} tries: ${error}`);
      return held ? 'failed' : 'taken over';
    }
    const held = await this.finish(d.id, attempt, {
      status: 'retrying',
      lastStatus: res?.status ?? null,
      lastError: error,
      nextAttemptAt: new Date(Date.now() + wait),
    });
    if (!held) return 'taken over';
    await this.enqueue(d.id, attempt + 1, wait);
    return 'retrying';
  }

  /** One row of the attempt log. Failing to write it never keeps the delivery's state unsaved. */
  private async logAttempt(row: typeof integrationAttempts.$inferInsert): Promise<void> {
    try {
      await this.db.insert(integrationAttempts).values(row);
    } catch (e) {
      log.warn(`delivery ${row.deliveryId}: try ${row.attempt} was not logged: ${message(e)}`);
    }
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

  /**
   * Ends try `attempt`, if it is still this worker's: once the sweeper has taken a try over
   * (its lease ran out), a late result changes nothing. True when it was saved.
   */
  private async finish(
    id: string,
    attempt: number,
    set: Partial<typeof integrationDeliveries.$inferInsert>,
  ): Promise<boolean> {
    const done = await this.db
      .update(integrationDeliveries)
      .set({ ...set, leaseUntil: null, updatedAt: new Date() })
      .where(
        and(
          eq(integrationDeliveries.id, id),
          eq(integrationDeliveries.attempts, attempt),
          eq(integrationDeliveries.status, 'sending'),
        ),
      )
      .returning({ id: integrationDeliveries.id });
    return done.length > 0;
  }

  /**
   * Every minute, for this queue prefix: a try whose lease ran out counts as a failed try (the
   * delivery moves on, or ends `failed` when the schedule is used up), and a due delivery whose
   * job was lost (a crash between the commit and the add) gets a job again. The longest waiting
   * go first, so one business's backlog does not hold back the others' older ones.
   */
  async sweep(): Promise<number> {
    const schedule = retrySchedule();
    const unfinished = await this.db
      .select({
        id: integrationDeliveries.id,
        tenantId: integrationDeliveries.tenantId,
        attempts: integrationDeliveries.attempts,
        url: integrationEndpoints.url,
      })
      .from(integrationDeliveries)
      .innerJoin(
        integrationEndpoints,
        and(
          eq(integrationEndpoints.id, integrationDeliveries.endpointId),
          eq(integrationEndpoints.tenantId, integrationDeliveries.tenantId),
        ),
      )
      .where(
        and(
          eq(integrationDeliveries.queues, config.queuePrefix),
          eq(integrationDeliveries.status, 'sending'),
          lt(integrationDeliveries.leaseUntil, sql`now()`),
        ),
      )
      .orderBy(asc(integrationDeliveries.leaseUntil))
      .limit(SWEEP_LIMIT);
    for (const d of unfinished) await this.giveUp(d, schedule);

    const due = await this.db
      .select({ id: integrationDeliveries.id, attempts: integrationDeliveries.attempts })
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.queues, config.queuePrefix),
          inArray(integrationDeliveries.status, ['pending', 'retrying']),
          lte(
            integrationDeliveries.nextAttemptAt,
            sql`now() - ${`${SWEEP_GRACE_MS} milliseconds`}::interval`,
          ),
        ),
      )
      .orderBy(asc(integrationDeliveries.nextAttemptAt))
      .limit(SWEEP_LIMIT);
    const minute = Math.floor(Date.now() / 60_000);
    for (const d of due) await this.enqueue(d.id, d.attempts + 1, 0, `sweep-${minute}`);
    return unfinished.length + due.length;
  }

  /** A try that did not finish: logged as such, then on as after any failed try. */
  private async giveUp(
    d: { id: string; tenantId: string; attempts: number; url: string },
    schedule: number[],
  ): Promise<void> {
    const wait = schedule[d.attempts - 1];
    const [moved] = await this.db
      .update(integrationDeliveries)
      .set({
        status: wait === undefined ? 'failed' : 'retrying',
        lastStatus: null,
        lastError: UNFINISHED,
        nextAttemptAt: wait === undefined ? null : new Date(Date.now() + wait),
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationDeliveries.id, d.id),
          eq(integrationDeliveries.status, 'sending'),
          eq(integrationDeliveries.attempts, d.attempts),
          lt(integrationDeliveries.leaseUntil, sql`now()`),
        ),
      )
      .returning({ id: integrationDeliveries.id });
    if (!moved) return;
    // The worker may have logged the try before it stopped.
    const [logged] = await this.db
      .select({ id: integrationAttempts.id })
      .from(integrationAttempts)
      .where(
        and(eq(integrationAttempts.deliveryId, d.id), eq(integrationAttempts.attempt, d.attempts)),
      )
      .limit(1);
    if (!logged)
      await this.logAttempt({
        tenantId: d.tenantId,
        deliveryId: d.id,
        attempt: d.attempts,
        url: d.url,
        status: null,
        error: UNFINISHED,
        durationMs: null,
        response: null,
      });
    if (wait === undefined) {
      log.warn(`delivery ${d.id} failed for good after ${d.attempts} tries: ${UNFINISHED}`);
      return;
    }
    await this.enqueue(d.id, d.attempts + 1, wait);
  }
}
