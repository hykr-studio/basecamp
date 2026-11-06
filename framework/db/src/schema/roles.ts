import { index, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * One person's access to one record: what an access rule's `granted` reach finds. A grant on
 * a parent record (a project) also reaches the children that point at it (`via` a column). The
 * business's own roles and its edits of the declared ones live in its settings (`roles`).
 */
export const recordGrants = app.table(
  'record_grants',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The record's entity name ('project'), as audited. */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** Who may reach it: a member of the business. */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    grantedBy: text('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('record_grants_one_idx').on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.userId,
    ),
    // What a scoped query asks: does this person hold a grant on this record?
    index('record_grants_user_idx').on(
      table.tenantId,
      table.userId,
      table.resourceType,
      table.resourceId,
    ),
  ],
);

/**
 * An invitation to join a business with some roles. Only the token's SHA-256 is stored: the
 * link is shown once, to the person who invites. Accepted once, by an account with this email.
 */
export const memberInvites = app.table(
  'member_invites',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** Lower case. */
    email: text('email').notNull(),
    roles: text('roles').array().notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: text('invited_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: text('accepted_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('member_invites_token_idx').on(table.tokenHash),
    index('member_invites_tenant_idx').on(table.tenantId, table.createdAt),
  ],
);
