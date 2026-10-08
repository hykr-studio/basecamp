/**
 * THE DOMAIN's tables (meetings, notes, to-dos). Replace this file to bring another domain;
 * framework tables (approvals, pages, channel links) stay in app.ts. Each table needs an
 * id, a tenant and an owner column (customerColumn() too, for records customers have), and
 * created_by/created_at/updated_at to get the framework's scoping, provenance and list grammar.
 */
import { sql } from 'drizzle-orm';
import { boolean, date, index, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { customerColumn, tenantColumn } from './tenancy.js';

export const meetings = app.table(
  'meetings',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    attendees: text('attendees').array().notNull().default(sql`'{}'::text[]`),
    status: text('status', { enum: ['scheduled', 'held', 'closed'] })
      .notNull()
      .default('scheduled'),
    /** Who made the row: the person, or the assistant acting for them. Set by the framework. */
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('meetings_owner_starts_idx').on(table.ownerId, table.startsAt),
    index('meetings_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
);

export const notes = app.table(
  'notes',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    /** Who made the row: the person, or the assistant acting for them. Set by the framework. */
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('notes_owner_created_idx').on(table.ownerId, table.createdAt),
    index('notes_meeting_idx').on(table.meetingId),
    index('notes_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
);

export const todos = app.table(
  'todos',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    done: boolean('done').default(false).notNull(),
    dueOn: date('due_on'),
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    /** Who made the row: the person, or the assistant acting for them. Set by the framework. */
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('todos_owner_id_idx').on(table.ownerId),
    index('todos_meeting_idx').on(table.meetingId),
    index('todos_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
);
