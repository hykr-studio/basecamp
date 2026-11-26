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
    /** The last time the person used the app on it: a push goes where they are (W1). */
    activeAt: timestamp('active_at', { withTimezone: true }),
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
    /** The Expo token; for a browser, its subscription's id (never the endpoint). */
    token: text('token').notNull(),
    /** 'web' for a browser's send (final when it is made: Web Push has no receipts). Else Expo. */
    platform: text('platform'),
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

/**
 * A person's browser, for web push (the push feature in @hykr/api): its push subscription,
 * registered for the business the person was working in, on the origin the app was open on. The
 * endpoint is the push service's address for this browser; the keys encrypt what is sent to it
 * (RFC 8291) and are sealed with SECRETS_KEY. A subscription belongs to one person at a time; it
 * is deleted when its owner forgets it or the push service says it is gone (404, 410).
 */
export const webPushSubscriptions = channel.table(
  'web_push_subscriptions',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    /** The browser's public key, sealed. */
    p256dh: text('p256dh').notNull(),
    /** The browser's authentication secret, sealed. */
    auth: text('auth').notNull(),
    /** The browser's name and system ("Chrome on macOS"), never the whole User-Agent. */
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** The last time the browser registered it (each sign-in). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    /** The last time the person used the app in this browser: a push goes where they are. */
    activeAt: timestamp('active_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('web_push_subscriptions_endpoint_tenant_idx').on(table.endpoint, table.tenantId),
    index('web_push_subscriptions_user_idx').on(table.tenantId, table.userId),
  ],
);
