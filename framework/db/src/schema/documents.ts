import { bigint, index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { contacts, messages } from './channel.js';
import { files } from './files.js';
import { tenantColumn } from './tenancy.js';

/**
 * Documents (PDFs) of records: one row per rendered version. The data it shows was read as the
 * person who asked, in their write, and is kept here (`data`), so every version shows what was
 * true when it was asked for. Written by the documents feature, which audits each step.
 */
export const documents = app.table(
  'documents',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The application's kind of document: 'orders.order'. */
    name: text('name').notNull(),
    /** The record it is about: an entity's name and the row's id. */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** 1, 2, …: per record and kind. */
    version: integer('version').notNull(),
    lang: text('lang').notNull().default('en'),
    status: text('status', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    /** What it shows, as its definition's `load` read it for the requester. */
    data: jsonb('data').notNull(),
    /**
     * The requester's roles and capabilities: who reads a copy must hold them (or the ones the
     * definition says matter).
     */
    seenAs: jsonb('seen_as').$type<{ roles: string[]; capabilities: string[] }>().notNull(),
    /** Who asked: the person (or the person the assistant acted for), or a contact. */
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    requestedByContact: text('requested_by_contact').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    /** The file's name, its type, and once made: the file, its size, pages and SHA-256. */
    fileName: text('file_name').notNull(),
    mime: text('mime').notNull().default('application/pdf'),
    fileId: text('file_id').references(() => files.id, { onDelete: 'set null' }),
    size: bigint('size', { mode: 'number' }),
    pages: integer('pages'),
    sha256: text('sha256'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    renderedAt: timestamp('rendered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('documents_version_idx').on(
      table.tenantId,
      table.name,
      table.resourceType,
      table.resourceId,
      table.version,
    ),
    index('documents_resource_idx').on(table.tenantId, table.resourceType, table.resourceId),
    index('documents_requested_by_idx').on(table.requestedBy),
  ],
);

/**
 * One send of a document to one recipient: by WhatsApp (the message row it became) or email.
 * Kept as evidence of what went to whom, and when.
 */
export const documentSends = app.table(
  'document_sends',
  {
    id: id(),
    tenantId: tenantColumn(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** The recipient as asked: { customerId } | { contactId } | { userId } | { email }. */
    recipient: jsonb('recipient').$type<Record<string, string>>().notNull(),
    /** Only this channel, when asked; else the one it went by. */
    channel: text('channel', { enum: ['whatsapp', 'email'] }),
    /** Where it went: the WhatsApp number or the email address. */
    address: text('address'),
    status: text('status', { enum: ['waiting', 'queued', 'sending', 'sent', 'failed'] })
      .notNull()
      .default('queued'),
    /**
     * The job delivering it ('sending'), and since when: only the job that claimed a send
     * delivers it, so it leaves at most once.
     */
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** The WhatsApp message it became. */
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    error: text('error'),
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    index('document_sends_document_idx').on(table.documentId),
    index('document_sends_waiting_idx').on(table.status, table.documentId),
  ],
);
