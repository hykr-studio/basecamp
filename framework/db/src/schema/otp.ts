import { index, integer, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id } from './base.js';
import { channel, contacts } from './channel.js';
import { tenants } from './tenancy.js';

/**
 * One-time codes, for any purpose (linking a number, accepting a document): sent to one address
 * (a WhatsApp number, an email; or an e-sign provider's name for a signing, which has no code),
 * stored only as a hash, spent once. What a code is for is its `purpose` and its `binding` (what
 * it was asked against: a document's hash, a record's version). Written by `OtpService`.
 */
export const otpChallenges = channel.table(
  'otp_challenges',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** What it is for: 'channel.link', 'acceptance'. Limits count per purpose. */
    purpose: text('purpose').notNull(),
    /** Who asked: a person with an account, or a WhatsApp contact without one. */
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    /** 'whatsapp', 'email', or 'esign' (a signing at a provider: no code). */
    channel: text('channel').notNull(),
    /** Where the code goes: a wa_id or an email address; an e-sign provider's name. */
    address: text('address').notNull(),
    /** sha256(<id>:<code>), once the code is made; null while it waits to be sent. */
    codeHash: text('code_hash'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** When the code was made and handed to its channel. */
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** The record it is about, when there is one. */
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    /** What it was asked against (a document's id and hash, a record's version). */
    binding: jsonb('binding').$type<Record<string, unknown>>(),
    /** Its purpose's own data (a time zone, the words shown, a provider's reference). */
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('otp_challenges_address_idx').on(table.purpose, table.address, table.createdAt),
    index('otp_challenges_user_idx').on(table.purpose, table.userId, table.createdAt),
    index('otp_challenges_contact_idx').on(table.purpose, table.contactId, table.createdAt),
    index('otp_challenges_resource_idx').on(table.tenantId, table.resourceType, table.resourceId),
  ],
);
