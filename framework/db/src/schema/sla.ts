import { sql } from 'drizzle-orm';
import { index, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * SLA clocks (the `sla` feature in @hykr/api): one row per SLA a record started when it entered
 * a state, written in the same transaction as the write that moved it. Leaving the state ends it
 * (`met`, or `breached` when its time had passed); a sweeper breaches the ones that run out while
 * the record is still there, and escalates them. In the database, not in Redis: a restart or a
 * flush loses none.
 */
export const slaTimers = app.table(
  'sla_timers',
  {
    id: id(),
    tenantId: tenantColumn(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** The module's SLA name: 'orders.decision'. */
    sla: text('sla').notNull(),
    /** The state it runs in. */
    state: text('state').notNull(),
    status: text('status', { enum: ['running', 'met', 'breached', 'cancelled'] })
      .notNull()
      .default('running'),
    /** 'business': only the business's open hours counted towards `dueAt`. */
    hours: text('hours', { enum: ['business', 'all'] })
      .notNull()
      .default('all'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    breachedAt: timestamp('breached_at', { withTimezone: true }),
    /** What the module said to do on a breach: { roles, transition }. */
    escalate: jsonb('escalate'),
    /** Why the escalation's transition did not run. */
    escalationError: text('escalation_error'),
    /** The queue prefix (BULL_PREFIX) of the process that started it: only its sweeper takes it. */
    queues: text('queues').notNull().default('bull'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('sla_timers_due_idx')
      .on(table.queues, table.dueAt)
      .where(sql`${table.status} = 'running'`),
    index('sla_timers_resource_idx').on(table.tenantId, table.resourceType, table.resourceId),
    index('sla_timers_status_idx').on(table.tenantId, table.status, table.dueAt),
  ],
);
