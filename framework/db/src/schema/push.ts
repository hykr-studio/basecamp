import { index, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id } from './base.js';
import { channel } from './channel.js';
import { tenants } from './tenancy.js';

/**
 * A person's phone, for push (the push feature in @hykr/api): its Expo push token, registered
 * for the business the person was working in. A token belongs to one person at a time; it is
 * deleted when its owner forgets it or the push service says the app is gone from the device.
 */
export const pushTokens = channel.table(
  'push_tokens',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** ExponentPushToken[…]. */
    token: text('token').notNull(),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** The last time the device registered it (each sign-in). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('push_tokens_token_tenant_idx').on(table.token, table.tenantId),
    index('push_tokens_user_idx').on(table.tenantId, table.userId),
  ],
);

/**
 * One push message to one device, as the push service accepted or refused it: the push log, and
 * what the receipt poll checks. `send` groups the messages of one notification to one person
 * (one per device); when every one of them failed, the notification moves to its next channel
 * with `meta`.
 */
export const pushTickets = channel.table(
  'push_tickets',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The notification to this person, across their devices. */
    send: text('send_id').notNull(),
    token: text('token').notNull(),
    /** The push service's ticket id, to ask for the receipt. None when it refused at once. */
    receiptId: text('receipt_id'),
    notification: text('notification').notNull(),
    dedupe: text('dedupe').notNull(),
    /** What the notification needs to move on to its next channel (NotificationMeta). */
    meta: jsonb('meta'),
    /** pending: waiting for its receipt; ok, error; expired: no receipt came. */
    status: text('status', { enum: ['pending', 'ok', 'error', 'expired'] }).notNull(),
    /** The push service's error code (DeviceNotRegistered, MessageRateExceeded…). */
    error: text('error'),
    /** The queue prefix (BULL_PREFIX) of the process that sent it: only its poll checks it. */
    queues: text('queues').notNull().default('bull'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (table) => [
    index('push_tickets_pending_idx').on(table.queues, table.status, table.createdAt),
    index('push_tickets_send_idx').on(table.send),
    index('push_tickets_user_idx').on(table.userId),
  ],
);
