import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const app = pgSchema('app');

/** A text uuid primary key, as every table uses. */
export const id = () => text('id').primaryKey().default(sql`gen_random_uuid()::text`);

export const approvals = app.table(
  'approvals',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
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
  (table) => [index('approvals_owner_status_idx').on(table.ownerId, table.status)],
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
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['whatsapp'] }).notNull(),
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
