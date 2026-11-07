// Agents a business makes (A6): their definitions (the `agent` entity in @hykr/contracts), each
// trigger with what it needs to fire again, the conditions' records already seen, and the run log.
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/** One agent: what it does, for whom, with which tools and budget, and what starts it. */
export const agents = app.table(
  'agents',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The person it acts for: who made it. Never changes. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    instructions: text('instructions').notNull(),
    /** AgentTrigger[]; `agent_triggers` holds each one's state. */
    triggers: jsonb('triggers').notNull().default([]),
    /** AgentScope: the tool ids it may use. */
    scope: jsonb('scope').notNull().default({ tools: [] }),
    /** AgentBudget. */
    budget: jsonb('budget').notNull().default({ period: 'month', maxSteps: 6 }),
    status: text('status', { enum: ['active', 'paused'] })
      .notNull()
      .default('active'),
    /** The application's template it was made from. */
    template: text('template'),
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
    index('agents_tenant_updated_idx').on(table.tenantId, table.updatedAt),
    index('agents_owner_idx').on(table.ownerId),
  ],
);

/**
 * One trigger of an agent, as the definition lists it (its position), with when it fires next
 * (time triggers and conditions) and the queue prefix (BULL_PREFIX) of the process that wrote it:
 * a worker fires only its own, so processes sharing a database never take each other's.
 */
export const agentTriggers = app.table(
  'agent_triggers',
  {
    id: id(),
    tenantId: tenantColumn(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    /** The trigger as the definition holds it. */
    spec: jsonb('spec').notNull(),
    /** When it is due: once, recurring and condition triggers; null when it never fires again. */
    nextAt: timestamp('next_at', { withTimezone: true }),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    queues: text('queues').notNull().default('bull'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('agent_triggers_agent_position_idx').on(table.agentId, table.position),
    index('agent_triggers_due_idx')
      .on(table.queues, table.nextAt)
      .where(sql`${table.nextAt} is not null`),
    index('agent_triggers_tenant_kind_idx').on(table.tenantId, table.kind),
  ],
);

/** The records a condition trigger has started a run for, while they still match. */
export const agentConditionHits = app.table(
  'agent_condition_hits',
  {
    triggerId: text('trigger_id')
      .notNull()
      .references(() => agentTriggers.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.recordId] })],
);

/**
 * The run log: one row per run of an agent, from queued to its end. `dedupe` makes a trigger
 * that fires twice for the same thing (an event relayed again, a tick retried) run once.
 */
export const agentRuns = app.table(
  'agent_runs',
  {
    id: id(),
    tenantId: tenantColumn(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** The run id its audit rows, trace, approvals and messages carry (32 hex). */
    runId: text('run_id').notNull(),
    triggerId: text('trigger_id').references(() => agentTriggers.id, { onDelete: 'set null' }),
    /** The trigger's kind, or 'manual'. */
    triggerKind: text('trigger_kind').notNull(),
    /** What fired it: a short description, and the data the run reads. */
    triggerLabel: text('trigger_label').notNull().default(''),
    input: jsonb('input'),
    dedupe: text('dedupe').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'waiting', 'done', 'failed', 'refused'],
    })
      .notNull()
      .default('queued'),
    reason: text('reason'),
    reply: text('reply'),
    /** ToolCallSummary[], as the chat summarizes a turn's calls. */
    toolCalls: jsonb('tool_calls').notNull().default([]),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    model: text('model'),
    agentVersion: text('agent_version'),
    /** How many other agents' runs led to this one. */
    depth: integer('depth').notNull().default(0),
    /** The agent's thread (no foreign key: the thread belongs to the conversations' tables). */
    threadId: text('thread_id'),
    queues: text('queues').notNull().default('bull'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('agent_runs_run_id_idx').on(table.runId),
    uniqueIndex('agent_runs_dedupe_idx').on(table.agentId, table.dedupe),
    index('agent_runs_agent_created_idx').on(table.agentId, table.createdAt),
    index('agent_runs_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('agent_runs_open_idx')
      .on(table.queues, table.status, table.updatedAt)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);
