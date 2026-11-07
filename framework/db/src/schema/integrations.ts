// The integration bus (decisions B10): where a business sends its events (webhook endpoints),
// what was sent and how each try went (deliveries, attempts), the outside systems it connects
// (connections, their credentials sealed), and what those systems sent in (inbound events).
// Secrets are stored sealed only (@hykr/connectors' secret box under SECRETS_KEY).
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

const at = (name: string) => timestamp(name, { withTimezone: true });

/** A URL a business sends its events to, signed with the endpoint's own secret. */
export const integrationEndpoints = app.table(
  'integration_endpoints',
  {
    id: id(),
    tenantId: tenantColumn(),
    url: text('url').notNull(),
    description: text('description'),
    /** Event names or patterns: 'task.created', 'task.*', '*'. */
    events: text('events').array().notNull(),
    /** What the endpoint may read besides plain fields (field policy): none by default. */
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
    /** 'active' | 'paused'. */
    status: text('status').notNull().default('active'),
    /** The signing secret, sealed for this row. */
    secretSealed: text('secret_sealed').notNull(),
    /** The secret before the last rotation: it signs too until previousExpiresAt. */
    previousSecretSealed: text('previous_secret_sealed'),
    previousExpiresAt: at('previous_expires_at'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [index('integration_endpoints_tenant_idx').on(table.tenantId, table.status)],
);

/** One event for one endpoint: the exact body, and where its sending stands. */
export const integrationDeliveries = app.table(
  'integration_deliveries',
  {
    /** The `webhook-id` header: the same on every try. */
    id: id(),
    tenantId: tenantColumn(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => integrationEndpoints.id, { onDelete: 'cascade' }),
    /** The stored event (app.domain_events.id): one delivery per endpoint and event. */
    eventId: text('event_id').notNull(),
    eventName: text('event_name').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    /** The JSON sent, byte for byte, already projected for the endpoint. */
    body: text('body').notNull(),
    /** 'pending' | 'sending' | 'retrying' | 'delivered' | 'failed' | 'cancelled'. */
    status: text('status').notNull().default('pending'),
    /** Tries made so far. */
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at'),
    /** While 'sending': a worker holds it until then (a worker that died lets go). */
    leaseUntil: at('lease_until'),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    deliveredAt: at('delivered_at'),
    /** The queue prefix (BULL_PREFIX) of the process that made it: only its workers take it. */
    queues: text('queues').notNull().default('bull'),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('integration_deliveries_event_idx').on(table.endpointId, table.eventId),
    index('integration_deliveries_log_idx').on(table.tenantId, table.endpointId, table.createdAt),
    index('integration_deliveries_due_idx')
      .on(table.queues, table.status, table.nextAttemptAt)
      .where(sql`${table.status} in ('pending', 'sending', 'retrying')`),
  ],
);

/** One try of a delivery: what the receiver answered, or why it did not. */
export const integrationAttempts = app.table(
  'integration_attempts',
  {
    id: id(),
    tenantId: tenantColumn(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => integrationDeliveries.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    url: text('url').notNull(),
    /** The HTTP status; null when no answer came. */
    status: integer('status'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    /** The start of the answer, for the log. */
    response: text('response'),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (table) => [index('integration_attempts_delivery_idx').on(table.deliveryId, table.attempt)],
);

/** A business's instance of a connector: its credentials, sealed. */
export const integrationConnections = app.table(
  'integration_connections',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The connector's name: 'standard-webhooks'. */
    connector: text('connector').notNull(),
    label: text('label'),
    /** 'active' | 'disabled'. */
    status: text('status').notNull().default('active'),
    /** The credentials as JSON, sealed for this row. */
    credentialsSealed: text('credentials_sealed').notNull(),
    /** The connector's public fields, in the clear. */
    public: jsonb('public').notNull().default({}),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [index('integration_connections_tenant_idx').on(table.tenantId, table.connector)],
);

/** One event an outside system sent, stored once per connection and sender's id. */
export const integrationInbound = app.table(
  'integration_inbound',
  {
    id: id(),
    tenantId: tenantColumn(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    /** The sender's id for the event. */
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    data: jsonb('data'),
    /** 'pending' | 'processing' | 'processed' | 'ignored' | 'failed'. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Each handler that finished: { '<handler>': 'done' }. */
    handled: jsonb('handled').notNull().default({}),
    error: text('error'),
    queues: text('queues').notNull().default('bull'),
    receivedAt: at('received_at').defaultNow().notNull(),
    processedAt: at('processed_at'),
  },
  (table) => [
    uniqueIndex('integration_inbound_event_idx').on(table.connectionId, table.externalId),
    index('integration_inbound_log_idx').on(table.tenantId, table.connectionId, table.receivedAt),
    index('integration_inbound_pending_idx')
      .on(table.queues, table.receivedAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);
