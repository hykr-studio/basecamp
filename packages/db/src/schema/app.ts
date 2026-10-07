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

const id = () => text('id').primaryKey().default(sql`gen_random_uuid()::text`);

export const meetings = app.table(
  'meetings',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    attendees: text('attendees').array().notNull().default(sql`'{}'::text[]`),
    status: text('status', { enum: ['scheduled', 'held', 'closed'] })
      .notNull()
      .default('scheduled'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('meetings_owner_starts_idx').on(table.ownerId, table.startsAt)],
);

export const notes = app.table(
  'notes',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('notes_owner_created_idx').on(table.ownerId, table.createdAt),
    index('notes_meeting_idx').on(table.meetingId),
  ],
);

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
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('todos_owner_id_idx').on(table.ownerId),
    index('todos_meeting_idx').on(table.meetingId),
  ],
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
