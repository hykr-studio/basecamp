import { sql } from 'drizzle-orm';
import { bigserial, index, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * The durable event outbox: what happened to a record, written in the same transaction as the
 * change (`recordEvents` in @hykr/core). If the write rolls back, there is no event; if the
 * process stops after commit, the event is still here for a relay to pass on to queues,
 * webhooks and live updates. One row is one `DomainEventEnvelope` (@hykr/contracts).
 *
 * Rows hold the record as stored, every field included: whatever passes an event on filters it
 * for its reader first (`eventFor`).
 */
export const domainEvents = app.table(
  'domain_events',
  {
    /** Unique per event: subscribers dedupe on it. */
    id: text('id').primaryKey(),
    /** The order events were written in, for a relay. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    tenantId: tenantColumn(),
    /** What happened: 'task.created', 'visit.rescheduled', 'approval.decided'. */
    name: text('name').notNull(),
    /** The module that owns the record, once modules exist. */
    module: text('module'),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    /** The record after the change (a deleted record as it was). */
    row: jsonb('row'),
    /** The record before an update or delete. */
    before: jsonb('before'),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    /** Whom it was done for: 'user:<id>' or 'contact:<id>'. */
    subject: text('subject'),
    channel: text('channel'),
    requestId: text('request_id'),
    runId: text('run_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Not passed on before this time: a tier 1 write's undo window. Otherwise occurredAt. */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    /** The queue prefix (BULL_PREFIX) of the process that wrote it: only its relay takes it. */
    queues: text('queues').notNull().default('bull'),
    /** When a relay passed it on. */
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
    /** When it was withdrawn before being passed on (an undone tier 1 write). */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [
    index('domain_events_pending_idx')
      .on(table.queues, table.availableAt, table.seq)
      .where(sql`${table.relayedAt} is null and ${table.cancelledAt} is null`),
    index('domain_events_resource_idx').on(table.tenantId, table.resourceType, table.resourceId),
    index('domain_events_request_idx').on(table.requestId),
  ],
);
