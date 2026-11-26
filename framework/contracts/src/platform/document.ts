import { z } from 'zod';
import { CreatedBy, commandSpec } from '../framework/spec.js';
import { LabelsShape, Lang, LangCode } from '../languages.js';

/**
 * Documents (PDFs) of records, as `/api/documents` shows them. An application declares each kind
 * (`defineDocument` in @hykr/api: what it reads and how it lays out); asking for one renders a
 * new version in the background, stored as a file; sending one delivers it by WhatsApp or email.
 */

/** Being made, made, or it could not be made (its error says why). */
export const DocumentStatus = z.enum(['pending', 'ready', 'failed']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

/** How a document goes out. */
export const DocumentChannel = z.enum(['whatsapp', 'email']);
export type DocumentChannel = z.infer<typeof DocumentChannel>;

/**
 * Whom a document goes to: yourself (the person asking, or the person the assistant acts for), a
 * customer of the business, a WhatsApp contact, a member (a person with an account in the
 * business), or an email address.
 */
export const DocumentRecipient = z.union([
  z.object({ self: z.literal(true).describe('Yourself: the person asking') }).strict(),
  z.object({ customerId: z.string().min(1).describe("A customer's id") }).strict(),
  z.object({ contactId: z.string().min(1).describe("A WhatsApp contact's id") }).strict(),
  z.object({ userId: z.string().min(1).describe("A member's id (yours: to yourself)") }).strict(),
  z.object({ email: z.email().max(254).describe('An email address') }).strict(),
]);
export type DocumentRecipient = z.infer<typeof DocumentRecipient>;

/**
 * One send: waiting for the document to be made, queued, sending (one job has claimed it and is
 * delivering it), sent (handed to WhatsApp, or emailed), or failed (`unreachable`: no channel
 * could reach the recipient; `interrupted`: its delivery stopped part way, and it is never sent
 * twice).
 */
export const DocumentSendStatus = z.enum(['waiting', 'queued', 'sending', 'sent', 'failed']);
export type DocumentSendStatus = z.infer<typeof DocumentSendStatus>;

export const DocumentSendInfo = z.object({
  id: z.string(),
  documentId: z.string(),
  to: DocumentRecipient,
  /** The channel it went by, once sent (or the one asked for). */
  channel: DocumentChannel.nullable(),
  status: DocumentSendStatus,
  error: z.string().nullable(),
  /** WhatsApp's own status of the message (sent, delivered, read, failed), when it went that way. */
  messageStatus: z.string().nullable(),
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
});
export type DocumentSendInfo = z.infer<typeof DocumentSendInfo>;

export const DocumentInfo = z.object({
  id: z.string(),
  /** The kind, as its module declares it: 'orders.order'. */
  document: z.string(),
  /** The record it is about. */
  record: z.object({ entity: z.string(), id: z.string() }),
  /** 1, 2, …: each render of a record's document is a new version. */
  version: z.number().int(),
  /** The record's version it was made from (a versioned entity): what an acceptance binds to. */
  recordVersion: z.number().int().nullable().optional(),
  lang: LangCode,
  status: DocumentStatus,
  /** The file's name: 'A-0001.pdf'. */
  name: z.string(),
  mime: z.string(),
  /** Once made. */
  size: z.number().int().nullable(),
  pages: z.number().int().nullable(),
  /** The PDF's SHA-256 (hex), once made: what an acceptance binds to. */
  sha256: z.string().nullable(),
  error: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  renderedAt: z.iso.datetime().nullable(),
  /** A short-lived download address, for people, once made. Relative ones are the API's. */
  url: z.string().optional(),
  urlExpiresAt: z.iso.datetime().optional(),
  /** Its sends, newest first (one document's read only). */
  sends: z.array(DocumentSendInfo).optional(),
});
export type DocumentInfo = z.infer<typeof DocumentInfo>;

/** A kind of document an entity has, as `GET /api/documents/kinds?entity=` lists it. */
export const DocumentKindInfo = z.object({
  name: z.string(),
  entity: z.string(),
  label: LabelsShape,
  channels: z.array(DocumentChannel),
});
export type DocumentKindInfo = z.infer<typeof DocumentKindInfo>;

export const RenderDocumentInput = z.object({
  document: z
    .string()
    .min(1)
    .max(100)
    .describe('The kind of document, as list-documents or the record names it'),
  id: z.string().min(1).max(100).describe('The id of the record it is about'),
  lang: Lang.optional().describe("Its language, one the application speaks. Default: 'en'"),
});
export type RenderDocumentInput = z.input<typeof RenderDocumentInput>;

/** Make a new version of a record's document (in the background: it starts `pending`). */
export const RenderDocumentSpec = commandSpec({
  name: 'document.render',
  description:
    "Make a PDF of a record: a new version of one of its documents, from the record as it is now. It is made in the background; get-document tells when it is ready. Give the document's kind and the record's id.",
  input: RenderDocumentInput,
  output: DocumentInfo,
  http: { method: 'POST', path: '/api/documents' },
  tool: 'render-document',
  expose: 'all',
  verb: { do: 'make', did: 'made' },
  touches: [],
});

export const SendDocumentInput = z.object({
  documentId: z.uuid().describe('The document to send (from render-document)'),
  to: DocumentRecipient,
  channel: DocumentChannel.optional().describe(
    'Only this channel. Default: WhatsApp when the recipient can get it there, else email',
  ),
});
export type SendDocumentInput = z.input<typeof SendDocumentInput>;

/** Send a document by WhatsApp or email: to yourself, or (with `customers.message`) to others. */
export const SendDocumentSpec = commandSpec({
  name: 'document.send',
  description:
    'Send a document (a PDF) to one recipient: a customer, a contact, a member or an email address, by WhatsApp or email. A document still being made goes once it is ready. Use it only when the user asks to send it.',
  input: SendDocumentInput,
  output: DocumentSendInfo,
  http: { method: 'POST', path: '/api/documents/:documentId/send' },
  tool: 'send-document',
  expose: 'all',
  approvalNote: 'When you call it, the send waits for the user to approve it.',
  verb: { do: 'send', did: 'sent' },
  touches: [],
});
