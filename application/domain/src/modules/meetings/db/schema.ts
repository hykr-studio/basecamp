/**
 * The meetings module's tables. Each table needs an id, a tenant and an owner column
 * (customerColumn() too, for records customers have), and created_by/created_at/updated_at to get
 * the framework's scoping, provenance and list grammar. Its tables are named after the module.
 */

import {
  addressColumn,
  app,
  customerColumn,
  geoIndex,
  geoPoint,
  id,
  tenantColumn,
  user,
} from '@hykr/db';
import { sql } from 'drizzle-orm';
import { doublePrecision, index, text, timestamp, unique } from 'drizzle-orm/pg-core';

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
    /** Where it is held: the address people read, and its point (PostGIS) for the map. */
    address: addressColumn('address'),
    location: geoPoint('location'),
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
    // What a to-do's or a note's (tenant_id, meeting_id) points at: a meeting of its business.
    unique('meetings_tenant_id_uq').on(table.tenantId, table.id),
    index('meetings_owner_starts_idx').on(table.ownerId, table.startsAt),
    index('meetings_tenant_customer_idx').on(table.tenantId, table.customerId),
    geoIndex('meetings_location_gist', table.location),
  ],
);

/**
 * Who checked in at a meeting, where and when: taken only by `meeting.check-in`, within the
 * module's radius of the meeting's point. The point, the distance and the fix's accuracy are
 * kept as evidence.
 */
export const meetingCheckIns = app.table(
  'meetings_check_ins',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    location: geoPoint('location').notNull(),
    distanceM: doublePrecision('distance_m').notNull(),
    accuracyM: doublePrecision('accuracy_m'),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('meetings_check_ins_meeting_idx').on(table.tenantId, table.meetingId)],
);
