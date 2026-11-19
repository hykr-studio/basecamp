import { sql } from 'drizzle-orm';
import { bigint, index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { contacts } from './channel.js';
import { tenantColumn } from './tenancy.js';

/**
 * Stored files (photos, documents, voice notes): the object in storage and what is known about
 * it. A file is uploaded first (pending until confirmed), then kept on one record's file field
 * (resource_type, resource_id, field). Who reaches it follows that record; before it is on one,
 * only whoever uploaded it does. Rows are written by the files feature, which audits each step.
 */
export const files = app.table(
  'files',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** Who uploaded it, when they have an account. */
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    /** The WhatsApp contact who sent it. */
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** upload, whatsapp or server (FileSource in @hykr/contracts). */
    source: text('source', { enum: ['upload', 'whatsapp', 'server'] })
      .notNull()
      .default('upload'),
    /** The object's key in storage: t/<tenant>/<id>, never from user input. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    /**
     * pending (presigned, not confirmed), ready, detached (taken off its record; deleted after a
     * grace period) or erased (its sender asked; deleted by the sweeper).
     */
    status: text('status', { enum: ['pending', 'ready', 'detached', 'erased'] })
      .notNull()
      .default('pending'),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256'),
    /** What it was uploaded for: an entity's file field, whose rules it was checked against. */
    intendedType: text('intended_type'),
    intendedField: text('intended_field'),
    /** The record field it is kept on. */
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    field: text('field'),
    /** An audio file's words, once transcribed, and their language. */
    transcript: text('transcript'),
    transcriptLang: text('transcript_lang'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Until when the upload may be sent (pending files). */
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
    /** When it left its record, or was erased: the sweeper deletes it after that. */
    detachedAt: timestamp('detached_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('files_key_idx').on(table.key),
    index('files_resource_idx').on(table.tenantId, table.resourceType, table.resourceId),
    index('files_owner_status_idx').on(table.ownerId, table.status, table.createdAt),
    index('files_contact_idx').on(table.contactId),
    index('files_sweep_idx')
      .on(table.status, table.detachedAt, table.createdAt)
      .where(sql`${table.status} <> 'ready'`),
  ],
);
