import { sql } from 'drizzle-orm';
import { index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { contacts } from './channel.js';
import { customers, tenants } from './tenancy.js';

/**
 * Share links (docs/decisions/B9.md): one record, saved page or public form a business shows to
 * someone without an account. Only the token's SHA-256 is kept. Every link ends (`expiresAt`),
 * can be revoked, may count its uses (a form's answers), and may ask its recipient for a one-time
 * code (`otpChannel`) before it shows anything. Rows stay after revocation, for the audit.
 */
export const shareLinks = app.table(
  'share_links',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** sha256(token), hex. */
    tokenHash: text('token_hash').notNull(),
    /** What it opens: 'record', 'page' or 'form'. */
    kind: text('kind', { enum: ['record', 'page', 'form'] }).notNull(),
    /** A record's entity name, or 'page'; null for a form. */
    resourceType: text('resource_type'),
    /** The record's or the page's id; null for a form. */
    resourceId: text('resource_id'),
    /** A public form's name. */
    form: text('form'),
    label: text('label'),
    /** Who made it. A shared page is read as this person sees it; gone with them. */
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Its recipient: a WhatsApp contact, a customer record, an email address. */
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    email: text('email'),
    /** Where its one-time code goes before anything is shown; null: no code. */
    otpChannel: text('otp_channel', { enum: ['whatsapp', 'email'] }),
    /** The address the code goes to (a wa_id or an email), fixed when it was made. */
    otpAddress: text('otp_address'),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    views: integer('views').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('share_links_token_idx').on(t.tokenHash),
    index('share_links_target_idx').on(t.tenantId, t.resourceType, t.resourceId),
    index('share_links_form_idx').on(t.tenantId, t.form).where(sql`${t.form} is not null`),
  ],
);

/**
 * What a right one-time code opened on a gated link: one device's session, for a while (never
 * past the link's end). Only the session token's SHA-256 is kept; revoking the link ends it.
 */
export const shareSessions = app.table(
  'share_sessions',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    linkId: text('link_id')
      .notNull()
      .references(() => shareLinks.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** The code that opened it (channel.otp_challenges). */
    challengeId: text('challenge_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('share_sessions_token_idx').on(t.tokenHash),
    index('share_sessions_link_idx').on(t.linkId),
  ],
);
