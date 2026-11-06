import type { DocumentInfo, DocumentSendInfo, Principal } from '@hykr/contracts';
import { type Conn, entityDef } from '@hykr/core';
import { documentSends, documents } from '@hykr/db';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { type DocumentDef, documents as documentDefs } from './define.js';

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentSendRow = typeof documentSends.$inferSelect;
export type SeenAs = DocumentRow['seenAs'];

/** The file a document holds, as the files table names it: no entity has this name. */
export const DOCUMENT_FILE = { resourceType: 'platform.document', field: 'file' } as const;

export const noSuchDocument = () =>
  new NotFoundException({ error: 'not_found', message: 'No such document' });

/** What a document's requester could see: their roles and capabilities. */
export const seenAsOf = (p: Principal): SeenAs => ({
  roles: [...(p.roles ?? [])].sort(),
  capabilities: [...(p.capabilities ?? [])].sort(),
});

/**
 * Does p see at least what the requester saw? With the definition's `capabilities`: p holds each
 * of those the requester held. Without: p holds every role and capability the requester held.
 */
export function covers(p: Principal, seenAs: SeenAs, matter?: readonly string[]): boolean {
  const caps = new Set(p.capabilities ?? []);
  if (matter)
    return matter.filter((c) => seenAs.capabilities.includes(c)).every((c) => caps.has(c));
  const roles = new Set(p.roles ?? []);
  return seenAs.roles.every((r) => roles.has(r)) && seenAs.capabilities.every((c) => caps.has(c));
}

/**
 * Can p reach this document? Same business; its kind still declared; the record it is about
 * reachable by p now (the entity's scoped repository: access, grants, plugins' scopes), an agent
 * only when the entity's `get` is exposed to it; and p sees at least what its requester saw.
 */
export async function reaches(
  conn: Conn,
  p: Principal,
  row: DocumentRow,
  /** Records already checked for p in this request, by "type:id". */
  seen = new Map<string, boolean>(),
): Promise<DocumentDef | undefined> {
  if (!p.tenantId || row.tenantId !== p.tenantId) return undefined;
  const def = documentDefs.get(row.name);
  const entity = entityDef(row.resourceType);
  if (!def || !entity) return undefined;
  if (p.actor.kind === 'agent' && entity.spec.expose.get !== 'all') return undefined;
  const key = `${entity.name}:${row.resourceId}`;
  if (!seen.has(key)) seen.set(key, !!(await entity.repo.find(conn, p, row.resourceId)));
  if (!seen.get(key)) return undefined;
  return covers(p, row.seenAs, def.capabilities) ? def : undefined;
}

/** A document p reaches, with its definition, or 404. */
export async function reachable(
  conn: Conn,
  p: Principal,
  id: string,
): Promise<{ row: DocumentRow; def: DocumentDef }> {
  const [row] = await conn
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.tenantId, p.tenantId ?? '')));
  const def = row ? await reaches(conn, p, row) : undefined;
  if (!row || !def) throw noSuchDocument();
  return { row, def };
}

/** A document as `/api/documents` shows it (no URL, no sends). */
export function infoOf(row: DocumentRow): DocumentInfo {
  return {
    id: row.id,
    document: row.name,
    record: { entity: row.resourceType, id: row.resourceId },
    version: row.version,
    lang: row.lang as DocumentInfo['lang'],
    status: row.status,
    name: row.fileName,
    mime: row.mime,
    size: row.size,
    pages: row.pages,
    sha256: row.sha256,
    error: row.error,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    renderedAt: row.renderedAt?.toISOString() ?? null,
  };
}

/** A send as `/api/documents` shows it. */
export function sendInfoOf(
  row: DocumentSendRow,
  messageStatus: string | null = null,
): DocumentSendInfo {
  return {
    id: row.id,
    documentId: row.documentId,
    to: row.recipient as DocumentSendInfo['to'],
    channel: row.channel,
    status: row.status,
    error: row.error,
    messageStatus,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

/**
 * What a stored event about a document carries: ids, kind, version and status, never the data it
 * shows (a webhook or a live feed passes events on).
 */
export const eventRowOf = (row: DocumentRow) => ({
  id: row.id,
  tenantId: row.tenantId,
  document: row.name,
  resourceType: row.resourceType,
  resourceId: row.resourceId,
  version: row.version,
  status: row.status,
  sha256: row.sha256,
});

/** A document event: stored in the outbox, by `runWrite` or by the worker. */
export class DocumentEvent {
  readonly resourceId: string;
  constructor(
    readonly eventName: string,
    readonly row: { id: string; tenantId: string } & Record<string, unknown>,
    /** 'document', or 'documentSend' for a send's events. */
    readonly resourceType = 'document',
  ) {
    this.resourceId = row.id;
  }
}
