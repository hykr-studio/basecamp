import { bigint, index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { audit } from './audit.js';

/**
 * Acceptance evidence: one row each time a person accepted a document of a record (by a one-time
 * code, or at an e-sign provider). Append-only: `sql/post/acceptances.sql` refuses UPDATE, DELETE
 * and TRUNCATE, and each row carries the hash of its fields and of the business's previous row,
 * so an edit or a gap shows. No foreign keys: evidence outlives what it names.
 */
export const acceptances = audit.table(
  'acceptances',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    /** 1, 2, …: the business's acceptances in order; `prevHash` is the row before. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** The application's acceptance: 'orders.order'. */
    name: text('name').notNull(),
    /** 'otp' or 'esign'. */
    method: text('method').notNull(),
    /** The record: its entity, id and the version that was accepted. */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    recordVersion: integer('record_version'),
    /** The PDF accepted: its row, kind, version, SHA-256 and file name. */
    documentId: text('document_id').notNull(),
    documentName: text('document_name').notNull(),
    documentVersion: integer('document_version').notNull(),
    documentSha256: text('document_sha256').notNull(),
    documentFileName: text('document_file_name').notNull(),
    /** The words agreed to, as shown, and their language. */
    statement: text('statement').notNull(),
    lang: text('lang').notNull(),
    /** Who signed: 'user' or 'contact', and their ids and name at the time. */
    signerKind: text('signer_kind').notNull(),
    signerUserId: text('signer_user_id'),
    signerContactId: text('signer_contact_id'),
    signerCustomerId: text('signer_customer_id'),
    signerName: text('signer_name'),
    /** The code: its challenge, channel, the address it went to, when sent and verified. */
    challengeId: text('challenge_id'),
    otpChannel: text('otp_channel'),
    otpAddress: text('otp_address'),
    otpSentAt: timestamp('otp_sent_at', { withTimezone: true }),
    otpVerifiedAt: timestamp('otp_verified_at', { withTimezone: true }),
    /** An e-sign: the provider, its reference and what it reported. */
    esignProvider: text('esign_provider'),
    esignRef: text('esign_ref'),
    esignCertificate: jsonb('esign_certificate').$type<Record<string, unknown>>(),
    /** The request: the address it came from, x-forwarded-for as sent, user agent, device. */
    ip: text('ip'),
    forwardedFor: text('forwarded_for'),
    userAgent: text('user_agent'),
    device: jsonb('device').$type<Record<string, string>>(),
    /** How it arrived (the principal's channel), how sure we were who it was, the request. */
    channel: text('channel'),
    assurance: text('assurance'),
    requestId: text('request_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
  },
  (table) => [
    uniqueIndex('acceptances_tenant_seq_idx').on(table.tenantId, table.seq),
    index('acceptances_resource_idx').on(table.tenantId, table.resourceType, table.resourceId),
    index('acceptances_document_idx').on(table.documentId),
  ],
);
