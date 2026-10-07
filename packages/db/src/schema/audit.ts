import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const audit = pgSchema('audit');

export const events = audit.table(
  'events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    actingFor: text('acting_for'),
    runId: text('run_id'),
    agentVersion: text('agent_version'),
    rule: text('rule'),
    reason: text('reason'),
    outcome: text('outcome').notNull().default('committed'),
    before: jsonb('before'),
    after: jsonb('after'),
  },
  (table) => [
    index('events_resource_idx').on(table.resourceType, table.resourceId),
    index('events_at_idx').on(table.at),
  ],
);
