import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const app = pgSchema('app');

const id = () =>
  text('id')
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

export const todos = app.table(
  'todos',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    title: text('title').notNull(),
    done: boolean('done').default(false).notNull(),
    dueOn: date('due_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('todos_owner_id_idx').on(table.ownerId)],
);

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
    resourceId: text('resource_id').notNull(),
    payload: jsonb('payload'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
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
