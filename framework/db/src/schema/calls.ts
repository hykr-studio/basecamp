// Phone calls (decisions B17): the log of a business's calls, usually about a record, written by
// hand, by the assistant, or from a telephony provider's updates.
import { index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

const at = (name: string) => timestamp(name, { withTimezone: true });

export const callLogs = app.table(
  'call_logs',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** 'inbound' | 'outbound'. */
    direction: text('direction').notNull(),
    /** requested, ringing, in_progress, completed, missed, failed or cancelled. */
    status: text('status').notNull(),
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    /** The member on the call. */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    /** The record it is about: an entity's name and the record's id. */
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    /** The telephony provider that connected it, and its id for the call. */
    provider: text('provider'),
    externalId: text('external_id'),
    startedAt: at('started_at'),
    endedAt: at('ended_at'),
    durationS: integer('duration_s'),
    notes: text('notes'),
    error: text('error'),
    /** 'person' | 'assistant' | 'system'. */
    createdBy: text('created_by').notNull().default('person'),
    /** Who wrote it down (a person, or the person the assistant acted for). */
    loggedBy: text('logged_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: at('created_at').defaultNow().notNull(),
    updatedAt: at('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('call_logs_resource_idx').on(table.tenantId, table.resourceType, table.resourceId),
    index('call_logs_person_idx').on(table.tenantId, table.userId),
    uniqueIndex('call_logs_external_uq').on(table.tenantId, table.provider, table.externalId),
  ],
);
