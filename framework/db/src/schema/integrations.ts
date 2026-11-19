// The integration bus (decisions B10): where a business sends its events (webhook endpoints),
// what was sent and how each try went (deliveries, attempts), the outside systems it connects
// (connections, their credentials sealed), and what those systems sent in (inbound events).
// Connections made by signing in (decisions B21) add their sign-ins under way, the accounts a
// grant reaches (what routes a provider's one webhook URL) and the events no account matched.
// Secrets are stored sealed only (@hykr/connectors' secret box under SECRETS_KEY).
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
    /** 'active' | 'disabled' | 'needs_reauth' (an OAuth grant the provider no longer takes). */
    status: text('status').notNull().default('active'),
    /** 'credentials' (given) | 'oauth' (a sign-in: the credentials are the grant's tokens). */
    auth: text('auth').notNull().default('credentials'),
    /** Whose connection: 'business' (a person's own may follow, decisions B21). */
    owner: text('owner').notNull().default('business'),
    /** The credentials as JSON, sealed for this row. */
    credentialsSealed: text('credentials_sealed').notNull(),
    /** The connector's public fields, in the clear. */
    public: jsonb('public').notNull().default({}),
    /** What the grant allows (OAuth only). */
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /** When the grant's access token stops working, if it does (OAuth only). */
    tokenExpiresAt: at('token_expires_at'),
    /** When its managers were told the grant ends soon (a grant that does not refresh). */
    expiryNoticeAt: at('expiry_notice_at'),
    /** Why it needs signing in again. */
    lastError: text('last_error'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [index('integration_connections_tenant_idx').on(table.tenantId, table.connector)],
);

/** One event an outside system sent, stored once per connection and key. */
export const integrationInbound = app.table(
  'integration_inbound',
  {
    id: id(),
    tenantId: tenantColumn(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    /**
     * The key the event is stored under, once per connection: the sender's id when the
     * connector signs it, else a hash of the signed body (`bodyKey`, `sha256:<hex>`).
     */
    externalId: text('external_id').notNull(),
    /** The id the sender gave when it is not the key: unverified, for the log only. */
    senderId: text('sender_id'),
    type: text('type').notNull(),
    data: jsonb('data'),
    /** 'pending' | 'processing' | 'processed' | 'ignored' | 'failed'. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Each handler that finished: { '<handler>': 'done' }. */
    handled: jsonb('handled').notNull().default({}),
    error: text('error'),
    queues: text('queues').notNull().default('bull'),
    /** The account a shared URL routed it by (a page id), else null. */
    accountId: text('account_id'),
    /** When the connector's `expand` turned it into its full form: it is not fetched again. */
    expandedAt: at('expanded_at'),
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

/**
 * A connection sign-in under way (decisions B21): who started it, in which business, for which
 * connector (and which connection, signing in again), the PKCE verifier (sealed for the row) and
 * where the browser returns. Used once, by that person only. Only the SHA-256 of the state the
 * provider carries is kept.
 */
export const integrationOauthStates = app.table(
  'integration_oauth_states',
  {
    id: id(),
    tenantId: tenantColumn(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    /** Signing an existing connection in again; null for a new one. */
    connectionId: text('connection_id').references(() => integrationConnections.id, {
      onDelete: 'cascade',
    }),
    label: text('label'),
    stateHash: text('state_hash').notNull(),
    verifierSealed: text('verifier_sealed').notNull(),
    /** Where the browser goes after the provider: one of the deployment's addresses. */
    returnTo: text('return_to').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('integration_oauth_states_state_uq').on(table.stateHash),
    index('integration_oauth_states_expires_idx').on(table.expiresAt),
  ],
);

/**
 * An account an OAuth connection's grant reaches (a Facebook page), as the provider named it at
 * sign-in. A held account receives the provider's shared webhook events for its id; at most one
 * connection anywhere holds an id (`account_connected_elsewhere`). Its own token, if the provider
 * gives one, is sealed for the row.
 */
export const integrationAccounts = app.table(
  'integration_accounts',
  {
    id: id(),
    tenantId: tenantColumn(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    /** The provider's id for it. */
    accountId: text('account_id').notNull(),
    name: text('name').notNull(),
    tokenSealed: text('token_sealed'),
    /** Picked: it receives events. Offered only, until the person picks it. */
    held: boolean('held').notNull().default(false),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('integration_accounts_connection_uq').on(table.connectionId, table.accountId),
    uniqueIndex('integration_accounts_held_uq')
      .on(table.connector, table.accountId)
      .where(sql`${table.held}`),
  ],
);

/**
 * An event a provider's shared URL sent for an account no connection holds: kept by its key so it
 * is logged once, without its content (it belongs to no business), and forgotten after 30 days.
 */
export const integrationUnrouted = app.table(
  'integration_unrouted',
  {
    id: id(),
    connector: text('connector').notNull(),
    accountId: text('account_id').notNull(),
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    receivedAt: at('received_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('integration_unrouted_event_uq').on(table.connector, table.externalId),
    index('integration_unrouted_received_idx').on(table.receivedAt),
  ],
);
