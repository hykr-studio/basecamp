import { index, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id } from './base.js';
import { channel } from './channel.js';
import { tenants } from './tenancy.js';

/**
 * A person's in-app inbox (the `inapp` delivery channel of the inbox feature in @hykr/api): what
 * notifications left for them in one business, in their language, until they read it. One item
 * per person and notification dedupe key, so a retried delivery adds nothing.
 */
export const inboxItems = channel.table(
  'inbox_items',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The notification's key ('comment.mention') and its dedupe key. */
    notification: text('notification').notNull(),
    dedupe: text('dedupe').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** An app path, when the notification gave one. */
    url: text('url'),
    /** The record it is about. */
    recordType: text('record_type'),
    recordId: text('record_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inbox_items_dedupe_idx').on(table.tenantId, table.userId, table.dedupe),
    index('inbox_items_user_idx').on(table.tenantId, table.userId, table.createdAt),
  ],
);
