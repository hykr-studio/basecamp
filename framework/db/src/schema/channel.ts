import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id } from './base.js';
import { customers, tenants } from './tenancy.js';

/**
 * Channel state (WhatsApp now): who is on the other end of a number, what they agreed to, what
 * was sent and received. Kept apart from the business tables in its own schema.
 */
export const channel = pgSchema('channel');

/**
 * One person on one number, for one business. A contact without an account is a customer of
 * that business; once the number is linked to an account, userId says whose.
 */
export const contacts = channel.table(
  'contacts',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['whatsapp'] })
      .notNull()
      .default('whatsapp'),
    /** The channel's id for the person: a WhatsApp wa_id (E.164 digits, no +). */
    address: text('address').notNull(),
    profileName: text('profile_name'),
    /** BCP 47 (en-IN, hi-IN, te-IN): the language replies and templates use. */
    locale: text('locale').notNull().default('en-IN'),
    timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    customerId: text('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'set null',
    }),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    /** Sent the one-time welcome and privacy notice. */
    welcomedAt: timestamp('welcomed_at', { withTimezone: true }),
    /**
     * WhatsApp said it can't reach them (not on WhatsApp, blocked us): later sends skip
     * WhatsApp until they message again.
     */
    unreachableAt: timestamp('unreachable_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('contacts_address_idx').on(table.tenantId, table.channel, table.address),
    index('contacts_user_idx').on(table.userId),
  ],
);

/** Which business a WhatsApp number belongs to: every webhook names the number it came to. */
export const numbers = channel.table('numbers', {
  phoneNumberId: text('phone_number_id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * What a contact agreed to, per topic: service (replies to their own messages), reminders, and
 * marketing. Append-only: the latest row per topic wins, and every change is audited.
 */
export const consents = channel.table(
  'consents',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    topic: text('topic', { enum: ['service', 'reminders', 'marketing'] }).notNull(),
    granted: boolean('granted').notNull(),
    /** app, web form, keyword, or staff:<userId> (consent given by phone). */
    source: text('source').notNull(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('consents_contact_topic_idx').on(table.contactId, table.topic, table.at)],
);

/**
 * Raw webhook messages, kept briefly: the unique provider id makes a redelivered webhook a
 * no-op, and the payload lets a failed message be replayed and debugged. Payloads are cleared
 * after 30 days.
 */
export const inboundEvents = channel.table(
  'inbound_events',
  {
    id: id(),
    providerMessageId: text('provider_message_id').notNull(),
    phoneNumberId: text('phone_number_id').notNull(),
    from: text('from').notNull(),
    payload: jsonb('payload'),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('inbound_events_provider_idx').on(table.providerMessageId),
    index('inbound_events_sender_idx').on(table.phoneNumberId, table.from, table.processedAt),
    index('inbound_events_received_idx').on(table.receivedAt),
  ],
);

/**
 * Every message in either direction, one row each, its status kept current by status webhooks.
 * The 24-hour window is computed from it: the contact's latest inbound message.
 */
export const messages = channel.table(
  'messages',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    /** whatsapp, or email when a notification fell back to it. */
    channel: text('channel', { enum: ['whatsapp', 'email'] })
      .notNull()
      .default('whatsapp'),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    providerMessageId: text('provider_message_id'),
    kind: text('kind', { enum: ['text', 'template', 'interactive', 'media'] }).notNull(),
    /** The outbound message itself (a normalized OutboundMessage), until it is sent. */
    body: jsonb('body'),
    template: text('template'),
    category: text('category'),
    status: text('status', {
      enum: ['received', 'queued', 'sent', 'delivered', 'read', 'failed'],
    }).notNull(),
    /** The agent turn it belongs to. */
    runId: text('run_id'),
    errorCode: integer('error_code'),
    /** The notification it carries (its key). */
    notification: text('notification'),
    /**
     * What a notification needs to move on if this send fails for good, or to answer its
     * buttons: the record it is about, the recipient, the dedupe key.
     */
    meta: jsonb('meta'),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    statusAt: timestamp('status_at', { withTimezone: true }),
  },
  (table) => [
    index('messages_window_idx').on(table.contactId, table.direction, table.at.desc()),
    uniqueIndex('messages_provider_idx')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
  ],
);

/** What the provider holds for each template in code, per language, compared by content hash. */
export const templates = channel.table(
  'templates',
  {
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: text('category').notNull(),
    contentHash: text('content_hash').notNull(),
    /** APPROVED, PENDING, REJECTED, PAUSED, DISABLED (the provider's words). */
    status: text('status').notNull(),
    providerId: text('provider_id'),
    rejectedReason: text('rejected_reason'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('templates_name_language_idx').on(table.name, table.language)],
);

/** A thread staff have taken from the assistant, until they hand it back. */
export const handoffs = channel.table(
  'handoffs',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['open', 'taken', 'closed'] })
      .notNull()
      .default('open'),
    takenBy: text('taken_by'),
    /** customer_asked, agent_failed, staff_took, agent_tool. */
    reason: text('reason').notNull(),
    /** What staff resolved, when they hand it back (the assistant reads it next). */
    resolution: text('resolution'),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('handoffs_one_open_idx').on(table.contactId).where(sql`${table.state} <> 'closed'`),
    index('handoffs_tenant_state_idx').on(table.tenantId, table.state, table.openedAt),
  ],
);

/** A one-time code sent to a number to link it to an account (login_code_v1). */
export const linkCodes = channel.table('link_codes', {
  id: id(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  address: text('address').notNull(),
  timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
