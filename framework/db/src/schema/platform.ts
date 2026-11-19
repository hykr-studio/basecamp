// The platform above the businesses (B19): its operators, their support access to a business
// (asked, consented by the business, time-boxed, every request logged), and the inbound requests
// the platform routed to a business. Statuses and modes are checked in sql/post/platform.sql.
import { sql } from 'drizzle-orm';
import { index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn, tenants } from './tenancy.js';

/**
 * A person who runs the deployment: one per account, with what they may do above the businesses
 * (`platform.*` operator capabilities). Disabled operators keep their row (the audit names them).
 */
export const platformOperators = app.table(
  'platform_operators',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
    note: text('note'),
    /** The operator (or `cli`) who added them. */
    addedBy: text('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('platform_operators_user_idx').on(table.userId)],
);

/**
 * An operator's access to one business, for a reason: requested by the operator, then consented
 * (or declined) by the business; active from consent until `ends_at`, unless ended sooner
 * (revoked by the business, ended by the operator). `user_id` is the operator's account, for the
 * lookup on every request.
 */
export const supportGrants = app.table(
  'platform_support_grants',
  {
    id: id(),
    tenantId: tenantColumn(),
    operatorId: text('operator_id')
      .notNull()
      .references(() => platformOperators.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    /** `read` (GET and HEAD only) or `write`. */
    access: text('access', { enum: ['read', 'write'] })
      .notNull()
      .default('read'),
    /** The business's roles whose access applies. */
    roles: text('roles').array().notNull(),
    /** The only capabilities held (not the roles'). */
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
    /** How long, from consent. */
    minutes: integer('minutes').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    requestExpiresAt: timestamp('request_expires_at', { withTimezone: true }).notNull(),
    consentedBy: text('consented_by'),
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    declinedBy: text('declined_by'),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    /** Ended before `ends_at`: by the business (`revoked`) or the operator. */
    endedBy: text('ended_by'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedHow: text('ended_how', { enum: ['revoked', 'ended'] }),
  },
  (table) => [
    index('platform_support_grants_tenant_idx').on(table.tenantId, table.requestedAt),
    index('platform_support_grants_user_idx').on(table.userId, table.tenantId),
    index('platform_support_grants_operator_idx').on(table.operatorId, table.requestedAt),
  ],
);

/** Every request an operator (or the assistant for them) made under a support grant. */
export const supportLog = app.table(
  'platform_support_log',
  {
    id: id(),
    grantId: text('grant_id')
      .notNull()
      .references(() => supportGrants.id, { onDelete: 'cascade' }),
    tenantId: tenantColumn(),
    actorKind: text('actor_kind').notNull(),
    method: text('method').notNull(),
    /** Without the query string. */
    path: text('path').notNull(),
    status: integer('status').notNull(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('platform_support_log_grant_idx').on(table.grantId, table.at)],
);

/**
 * An inbound request the platform was asked to route (a message to the platform's number, a
 * form): which router chose which business, and what that business made of it. Its content is
 * not kept. One per `(source, ref)`: routed once.
 */
export const routedRequests = app.table(
  'platform_routed',
  {
    id: id(),
    source: text('source').notNull(),
    ref: text('ref').notNull(),
    router: text('router'),
    tenantId: text('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    /** `routed`, `unrouted` or `failed`. */
    status: text('status', { enum: ['routed', 'unrouted', 'failed'] }).notNull(),
    reason: text('reason'),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('platform_routed_ref_idx').on(table.source, table.ref),
    index('platform_routed_at_idx').on(table.createdAt),
    index('platform_routed_tenant_idx').on(table.tenantId, table.createdAt),
  ],
);
