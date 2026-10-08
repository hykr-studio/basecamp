import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const audit = pgSchema('audit');

export const events = audit.table(
  'events',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    actingFor: text('acting_for'),
    runId: text('run_id'),
    /** The HTTP request that caused this row; an approval's replay shares the approve request's. */
    requestId: text('request_id'),
    /** For a replayed approval: the person who approved what the actor asked for. */
    approvedBy: text('approved_by'),
    agentVersion: text('agent_version'),
    /** How the turn reached the assistant: app, voice or whatsapp (null for direct API use). */
    channel: text('channel'),
    rule: text('rule'),
    reason: text('reason'),
    outcome: text('outcome').notNull().default('committed'),
    before: jsonb('before'),
    after: jsonb('after'),
  },
  (table) => [
    index('events_resource_idx').on(table.resourceType, table.resourceId),
    index('events_at_idx').on(table.at),
    index('events_run_idx').on(table.runId),
    index('events_request_idx').on(table.requestId),
  ],
);
