import { sql } from 'drizzle-orm';
import { index, integer, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { threadMessages } from './app.js';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * The business's memory: lasting facts every member's assistant may recall (the `memory` entity
 * in @hykr/contracts). Memory of one record is the application's own entity with the `memory`
 * trait; it lives in that entity's table.
 */
export const memories = app.table(
  'memories',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** Who wrote it (the person the assistant acted for, when it was the assistant). */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    text: text('text').notNull(),
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
    index('memories_tenant_updated_idx').on(table.tenantId, table.updatedAt),
    index('memories_owner_idx').on(table.ownerId),
  ],
);

/**
 * What semantic recall searches: one vector per record that is memory (an entity with the
 * `memory` trait) and per thing a person said. It holds no text: recall loads each source again
 * as the reader, so what they may no longer see is never shown. Vectors are compared only with
 * vectors of the same model.
 */
export const memoryIndex = app.table(
  'memory_index',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** 'record': an entity's record; 'message': something a person said in a turn. */
    kind: text('kind', { enum: ['record', 'message'] }).notNull(),
    /** The entity's name ('note'), or 'message'. */
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    /** A message's row: its vector goes when it does (erasure, a deleted thread). */
    messageId: text('message_id').references(() => threadMessages.id, { onDelete: 'cascade' }),
    /** Whose words, for a message: 'user:<id>' or 'contact:<id>'. */
    subject: text('subject'),
    /** The record a record is memory of, as its trait said when it was indexed. */
    aboutType: text('about_type'),
    aboutId: text('about_id'),
    /** The embedding model that made the vector ('<provider>/<model>'); null while pending. */
    model: text('model'),
    embedding: real('embedding').array(),
    /** pending: to embed; ready: searchable; failed: gave up (a policy change retries it). */
    state: text('state', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    /** The queue prefix (BULL_PREFIX) of the process that indexes it. */
    queues: text('queues').notNull().default('bull'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('memory_index_source_idx').on(table.tenantId, table.sourceType, table.sourceId),
    index('memory_index_search_idx').on(table.tenantId, table.model, table.kind),
    index('memory_index_about_idx').on(table.tenantId, table.aboutType, table.aboutId),
    index('memory_index_subject_idx').on(table.tenantId, table.subject),
    index('memory_index_pending_idx')
      .on(table.queues, table.updatedAt)
      .where(sql`${table.state} = 'pending'`),
  ],
);
