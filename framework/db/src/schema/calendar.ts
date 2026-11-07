// Calendars (decisions B17): a person's connection to their own calendar (tokens sealed), which
// records are in it as which events, the invites emailed for records, private feeds, and
// sign-ins under way.
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { integrationConnections } from './integrations.js';
import { tenantColumn } from './tenancy.js';

const at = (name: string) => timestamp(name, { withTimezone: true });

/** One person's calendar account, in one business. */
export const calendarConnections = app.table(
  'calendar_connections',
  {
    id: id(),
    tenantId: tenantColumn(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'google'. */
    provider: text('provider').notNull(),
    /** The account's email. */
    account: text('account').notNull(),
    calendarId: text('calendar_id').notNull().default('primary'),
    /** 'active' | 'needs_reauth' | 'stopped'. */
    status: text('status').notNull().default('active'),
    /** The grant's tokens as JSON, sealed for this row. */
    tokensSealed: text('tokens_sealed').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /** Where changes were last read up to. */
    syncToken: text('sync_token'),
    /** The open push channel, if any. */
    channelId: text('channel_id'),
    channelResourceId: text('channel_resource_id'),
    channelExpiresAt: at('channel_expires_at'),
    /** The B10 connection Google's notifications are posted to. */
    inboundConnectionId: text('inbound_connection_id').references(() => integrationConnections.id, {
      onDelete: 'set null',
    }),
    lastSyncedAt: at('last_synced_at'),
    lastError: text('last_error'),
    /** The queue prefix whose worker looks after it (BULL_PREFIX). */
    queues: text('queues').notNull().default('bull'),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_connections_person_uq').on(table.tenantId, table.userId, table.provider),
    index('calendar_connections_queues_idx').on(table.queues, table.status),
  ],
);

/** A record in one connected calendar: the event it is there, and what was sent. */
export const calendarEventLinks = app.table(
  'calendar_event_links',
  {
    id: id(),
    tenantId: tenantColumn(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => calendarConnections.id, { onDelete: 'cascade' }),
    /** The entity's name and the record's id. */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** The provider's event id. */
    externalId: text('external_id').notNull(),
    /** 'synced' | 'removed' (the person deleted it in their calendar). */
    status: text('status').notNull().default('synced'),
    /** A hash of what was last sent: an unchanged record sends nothing. */
    hash: text('hash'),
    sentStartsAt: at('sent_starts_at'),
    sentEndsAt: at('sent_ends_at'),
    /** Where the person moved it in their calendar, if they did. */
    externalStartsAt: at('external_starts_at'),
    externalEndsAt: at('external_ends_at'),
    syncedAt: at('synced_at'),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_event_links_record_uq').on(
      table.connectionId,
      table.resourceType,
      table.resourceId,
    ),
    index('calendar_event_links_resource_idx').on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
    ),
    index('calendar_event_links_external_idx').on(table.connectionId, table.externalId),
  ],
);

/** An invite to one record for one address: its sequence and what it last said. */
export const calendarInvites = app.table(
  'calendar_invites',
  {
    id: id(),
    tenantId: tenantColumn(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    /** The member it went to, when it was one. */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    /** RFC 5545 SEQUENCE: one more for each update after the first. */
    sequence: integer('sequence').notNull().default(0),
    /** 'REQUEST' | 'CANCEL'. */
    method: text('method').notNull().default('REQUEST'),
    /** 'queued' | 'sending' | 'sent' | 'failed'. One send at a time (an advisory lock). */
    status: text('status').notNull().default('queued'),
    lang: text('lang').notNull().default('en'),
    /** Who asked: the record is read as them for every version. */
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    /** What the last send said (title, times, place), and its hash. */
    sent: jsonb('sent'),
    sentHash: text('sent_hash'),
    error: text('error'),
    sentAt: at('sent_at'),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_invites_recipient_uq').on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.email,
    ),
  ],
);

/** A person's private feed: only the token's SHA-256 is kept. */
export const calendarFeeds = app.table(
  'calendar_feeds',
  {
    id: id(),
    tenantId: tenantColumn(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    label: text('label'),
    tokenHash: text('token_hash').notNull(),
    lastUsedAt: at('last_used_at'),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_feeds_token_uq').on(table.tokenHash),
    index('calendar_feeds_person_idx').on(table.tenantId, table.userId),
  ],
);

/**
 * A calendar sign-in under way (decisions B17, 36): who started it, in which business, the PKCE
 * verifier (sealed for the row), and where the browser returns. Used once, by that person only.
 * Only the SHA-256 of the state Google carries is kept.
 */
export const calendarOauthStates = app.table(
  'calendar_oauth_states',
  {
    id: id(),
    tenantId: tenantColumn(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'google'. */
    provider: text('provider').notNull(),
    stateHash: text('state_hash').notNull(),
    verifierSealed: text('verifier_sealed').notNull(),
    /** Where the browser goes after the provider: one of the deployment's addresses. */
    returnTo: text('return_to').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('calendar_oauth_states_state_uq').on(table.stateHash),
    index('calendar_oauth_states_expires_idx').on(table.expiresAt),
  ],
);
