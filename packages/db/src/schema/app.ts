import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { contacts } from './channel.js';
import { tenantColumn } from './tenancy.js';

export { app, id };

export const approvals = app.table(
  'approvals',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** Who asked, when they have an account; a contact's request names the contact instead. */
    ownerId: text('owner_id').references(() => user.id),
    requesterContactId: text('requester_contact_id'),
    /** Who decides: one person (their own assistant's request), or anyone with these roles. */
    approverUserId: text('approver_user_id'),
    approverRoles: text('approver_roles').array().notNull().default(sql`'{}'::text[]`),
    /** Where it may be decided (null: anywhere the decider may act). */
    approverChannels: text('approver_channels').array(),
    minAssurance: text('min_assurance'),
    action: text('action').notNull(),
    rule: text('rule').notNull(),
    reason: text('reason').notNull(),
    resourceType: text('resource_type').notNull(),
    // Null when the parked operation creates its first row (nothing to point at yet).
    resourceId: text('resource_id'),
    /** What the person sees: Close "Site review" with 1 note and 3 to-dos. */
    summary: text('summary'),
    /** The parked operation: { op, args, principal }, replayed as-is on approval. */
    payload: jsonb('payload'),
    requestedBy: text('requested_by', { enum: ['user', 'agent'] })
      .notNull()
      .default('agent'),
    runId: text('run_id'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('approvals_owner_status_idx').on(table.ownerId, table.status),
    index('approvals_tenant_status_idx').on(table.tenantId, table.status),
  ],
);

export const idempotencyKeys = app.table(
  'idempotency',
  {
    key: text('key').notNull(),
    principalId: text('principal_id').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.principalId] })],
);

/** A canvas page the person saved: a PageSpec of queries, so it always shows today's data. */
export const pages = app.table(
  'pages',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    name: text('name').notNull(),
    spec: jsonb('spec').notNull(),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('pages_owner_name_idx').on(table.ownerId, table.name)],
);

/**
 * A person's address on a channel without a screen (WhatsApp now, voice later): who a
 * message from that number acts for. One address belongs to one person.
 */
export const channelLinks = app.table(
  'channel_links',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** voice: reserved for phone voice (a number calling in); the app's voice needs no link. */
    channel: text('channel', { enum: ['whatsapp', 'voice'] }).notNull(),
    /** The channel's own id for the person: a WhatsApp wa_id (digits only). */
    address: text('address').notNull(),
    /** The person's IANA zone, from the app when they linked: times in replies read as theirs. */
    timeZone: text('time_zone').notNull().default('UTC'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('channel_links_address_idx').on(table.channel, table.address),
    uniqueIndex('channel_links_owner_idx').on(table.channel, table.ownerId),
  ],
);

/**
 * A conversation the server keeps for one person (typed, spoken and WhatsApp turns), or for a
 * WhatsApp contact without an account. Exactly one of the two.
 */
export const threads = app.table(
  'threads',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('threads_owner_updated_idx').on(table.ownerId, table.updatedAt),
    index('threads_contact_updated_idx').on(table.contactId, table.updatedAt),
    check('threads_one_subject', sql`(${table.ownerId} is null) <> (${table.contactId} is null)`),
  ],
);

/**
 * One saved message: what the person said (or typed), or the assistant's reply with its tool
 * calls and their present intents, so the app renders history exactly as it streamed.
 */
export const threadMessages = app.table(
  'thread_messages',
  {
    id: id(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    text: text('text').notNull().default(''),
    /** UI message parts after the text: tool calls with their inputs and outputs. */
    parts: jsonb('parts').notNull().default([]),
    channel: text('channel', { enum: ['app', 'voice', 'whatsapp'] })
      .notNull()
      .default('app'),
    lang: text('lang', { enum: ['en', 'hi', 'te'] }),
    runId: text('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Insertion order: two messages in the same millisecond still read in the order saved. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('thread_messages_thread_created_idx').on(table.threadId, table.createdAt),
    index('thread_messages_thread_seq_idx').on(table.threadId, table.seq),
  ],
);

/**
 * Notifications to send, written in the same transaction as the business change that causes
 * them: if it rolls back, nothing is sent; if the process stops after commit, a relay still
 * delivers them.
 */
export const outbox = app.table(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantColumn(),
    /** The notification's key, e.g. meeting.reminder. */
    key: text('key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
  },
  (table) => [index('outbox_pending_idx').on(table.id).where(sql`${table.relayedAt} is null`)],
);
