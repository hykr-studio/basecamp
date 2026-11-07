import {
  type AuthorizeResult,
  maskAddress,
  type OtpChannel,
  type Principal,
  transitionNamed,
  versionedOf,
  versionField,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  allow,
  type Conn,
  checkTransition,
  deny,
  entityDef,
  machineOf,
  tenantOf,
} from '@hykr/core';
import { acceptances, contacts, customers, documents, user } from '@hykr/db';
import type { Lang } from '@hykr/i18n';
import { can, subjectOf } from '@hykr/policy';
import { NotFoundException } from '@nestjs/common';
import { and, type Column, eq, getTableColumns, or, type SQL, sql, type Table } from 'drizzle-orm';
import { type DocumentRow, reachable } from '../documents/access.js';
import { renderContextOf, type Snapshot } from '../documents/commands.js';
import type { DocumentDef } from '../documents/define.js';
import { type AcceptanceDef, acceptanceOf, channelsOfAcceptance } from './define.js';

type Values = Record<string, unknown>;

/** What the OTP service calls an acceptance's codes, and a signing at a provider. */
export const ACCEPTANCE_PURPOSE = 'acceptance';
export const ESIGN_PURPOSE = 'acceptance.esign';

/** A document, its acceptance and the record it is about, as stored now. */
export interface Resolved {
  def: AcceptanceDef;
  doc: DocumentRow;
  docDef?: DocumentDef;
  entity: AnyEntityDef;
  /** The record as stored (never sent anywhere as is). */
  row: Values;
  /** The record's version now. */
  version: number | null;
}

/** Who signs, as the business knows them, and where their codes can go. */
export interface Signer {
  kind: 'user' | 'contact';
  userId: string | null;
  contactId: string | null;
  customerId: string | null;
  name: string | null;
  whatsapp: string | null;
  email: string | null;
  /** The contact a WhatsApp code is sent to (theirs, or the one linked to their account). */
  whatsappContactId: string | null;
}

/** What a code challenge is bound to (stored on it, compared when it is used). */
export interface Binding {
  acceptance: string;
  documentId: string;
  documentVersion: number;
  sha256: string;
  recordVersion: number | null;
}

const notFound = (message: string) => new NotFoundException({ error: 'not_found', message });

/** The record's version, as stored. */
export function versionOfRow(entity: AnyEntityDef, row: Values): number | null {
  const trait = versionedOf(entity.spec);
  const v = trait ? row[versionField(trait)] : undefined;
  return typeof v === 'number' ? v : null;
}

/** Hold the record's row until the write commits: two acceptances run one after the other. */
async function lockRow(conn: Conn, p: Principal, entity: AnyEntityDef, id: string) {
  const cols = getTableColumns(entity.table as Table) as Record<string, Column>;
  await conn
    .select({ id: sql<string>`${cols.id}` })
    .from(entity.table as Table)
    .where(and(eq(cols.id as Column, id), eq(cols.tenantId as Column, tenantOf(p))))
    .for('update');
}

/**
 * The document p reaches (404 otherwise: another business, a record they do not reach, a copy
 * made by someone who saw more), its acceptance (404 when it has none), and its record as
 * stored, locked when asked.
 */
export async function resolveFor(
  conn: Conn,
  p: Principal,
  documentId: string,
  opts: { lock?: boolean } = {},
): Promise<Resolved> {
  const { row: doc, def: docDef } = await reachable(conn, p, documentId);
  const def = acceptanceOf(doc.name);
  if (!def) throw notFound('Nothing to accept here');
  const entity = entityDef(doc.resourceType);
  if (!entity) throw notFound('No such document');
  if (opts.lock) await lockRow(conn, p, entity, doc.resourceId);
  const row = (await entity.repo.find(conn, p, doc.resourceId)) as Values | null;
  if (!row) throw notFound('No such document');
  return { def, doc, docDef, entity, row, version: versionOfRow(entity, row) };
}

/**
 * The same for the business's own work (an e-sign provider's result): the document read by id
 * in that business, the record as the system principal reaches it.
 */
export async function resolveForSystem(
  conn: Conn,
  p: Principal,
  documentId: string,
): Promise<Resolved> {
  const [doc] = await conn
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantOf(p))));
  const def = doc ? acceptanceOf(doc.name) : undefined;
  const entity = doc ? entityDef(doc.resourceType) : undefined;
  if (!doc || !def || !entity) throw notFound('No such document');
  await lockRow(conn, p, entity, doc.resourceId);
  const row = (await entity.repo.find(conn, p, doc.resourceId)) as Values | null;
  if (!row) throw notFound('No such document');
  return { def, doc, entity, row, version: versionOfRow(entity, row) };
}

/** The signer: the principal's subject, with their name, number and email in this business. */
export async function signerOf(conn: Conn, p: Principal): Promise<Signer | undefined> {
  const subject = subjectOf(p);
  const tenantId = tenantOf(p);
  if (subject?.kind === 'user') {
    const [u] = await conn
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, subject.userId));
    const [c] = await conn
      .select({ id: contacts.id, address: contacts.address })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.userId, subject.userId)));
    return {
      kind: 'user',
      userId: subject.userId,
      contactId: null,
      customerId: p.customerId ?? null,
      name: u?.name ?? null,
      whatsapp: c?.address ?? null,
      email: u?.email ?? null,
      whatsappContactId: c?.id ?? null,
    };
  }
  if (subject?.kind === 'contact') {
    const [c] = await conn
      .select({
        address: contacts.address,
        profileName: contacts.profileName,
        customerId: contacts.customerId,
        customerName: customers.displayName,
      })
      .from(contacts)
      .leftJoin(customers, eq(customers.id, contacts.customerId))
      .where(and(eq(contacts.id, subject.contactId), eq(contacts.tenantId, tenantId)));
    if (!c) return undefined;
    return {
      kind: 'contact',
      userId: null,
      contactId: subject.contactId,
      customerId: p.customerId ?? c.customerId ?? null,
      name: c.profileName ?? c.customerName ?? null,
      whatsapp: c.address,
      email: null,
      whatsappContactId: subject.contactId,
    };
  }
  return undefined;
}

/** Where this acceptance's codes can go for this signer, in the acceptance's order. */
export function addressesOf(
  def: AcceptanceDef,
  signer: Signer | undefined,
): { channel: OtpChannel; address: string }[] {
  if (!signer) return [];
  return channelsOfAcceptance(def).flatMap((channel) => {
    const address = channel === 'whatsapp' ? signer.whatsapp : signer.email;
    return address ? [{ channel, address }] : [];
  });
}

/** The same, masked, for the person to see. */
export const shownAddresses = (def: AcceptanceDef, signer: Signer | undefined) =>
  addressesOf(def, signer).map((a) => ({ channel: a.channel, sentTo: maskAddress(a.address) }));

/** May p sign for this record, as the acceptance says? */
export function signs(p: Principal, def: AcceptanceDef, row: Values): boolean {
  if (def.by === 'customer') return !!p.customerId && row.customerId === p.customerId;
  if (typeof def.by === 'function') return def.by(p, row);
  return can(p, def.by.capability);
}

/** Has this signer accepted this PDF already? */
export async function acceptedBefore(
  conn: Conn,
  tenantId: string,
  documentId: string,
  signer: Pick<Signer, 'userId' | 'contactId'>,
): Promise<boolean> {
  const who: SQL[] = [];
  if (signer.userId) who.push(eq(acceptances.signerUserId, signer.userId));
  if (signer.contactId) who.push(eq(acceptances.signerContactId, signer.contactId));
  const by = or(...who);
  if (!by) return false;
  const [hit] = await conn
    .select({ id: acceptances.id })
    .from(acceptances)
    .where(and(eq(acceptances.tenantId, tenantId), eq(acceptances.documentId, documentId), by))
    .limit(1);
  return !!hit;
}

/**
 * Whether the record and its PDF can be accepted now, apart from who signs: the PDF is made, it
 * was made from the record as it is now, the acceptance's own check, and its transition can run.
 */
export function acceptable(r: Resolved, p: Principal): AuthorizeResult | null {
  if (r.doc.status !== 'ready' || !r.doc.sha256)
    return deny('document_not_ready', 'This PDF is not made yet');
  if (r.doc.recordVersion === null || r.doc.recordVersion !== r.version)
    return deny(
      'document_stale',
      'This PDF was made before the last change to the record: make it again',
    );
  const refused = r.def.when?.(r.row);
  if (refused) return deny(refused.rule, refused.reason);
  if (r.def.transition) {
    const t = transitionNamed(machineOf(r.entity), r.def.transition);
    if (!t) return deny('no_such_transition', `The record has no "${r.def.transition}"`);
    const stuck = checkTransition(r.entity, t, r.row, {}, p, { who: false });
    if (stuck) return stuck;
  }
  return null;
}

/**
 * The decision for a person asking to accept (a code, a signing, the acceptance itself): people
 * only, the acceptance's signer, not accepted before, and the PDF acceptable now.
 */
export function decide(
  p: Principal,
  r: Resolved,
  a: { prior: boolean; signer: Signer | undefined },
): AuthorizeResult {
  if (p.actor.kind === 'agent')
    return deny('humans_only', 'Only the person accepts: the assistant cannot');
  if (p.actor.kind === 'system' || !a.signer)
    return deny('people_only', 'Only a person can accept a document');
  if (!signs(p, r.def, r.row))
    return deny('not_signer', 'You are not the one who accepts this document');
  if (a.prior) return deny('already_accepted', 'You have already accepted this PDF');
  const refused = acceptable(r, p);
  if (refused) return refused;
  return allow('signer_accepts', 'The signer accepts the document they were shown');
}

/** The words the signer agrees to, from the PDF's stored data, in this language. */
export function statementOf(r: Pick<Resolved, 'def' | 'doc'>, lang: Lang): string {
  const snapshot = r.doc.data as Snapshot;
  return r.def.statement(snapshot.value, renderContextOf(lang, snapshot.business)).trim();
}

/** What a code is bound to: this PDF of this version of the record. */
export const bindingOf = (r: Resolved): Binding => ({
  acceptance: r.def.name,
  documentId: r.doc.id,
  documentVersion: r.doc.version,
  sha256: r.doc.sha256 ?? '',
  recordVersion: r.version,
});

/** The business's name, from the PDF's snapshot (as it was when made). */
export const businessName = (doc: DocumentRow) => (doc.data as Snapshot).business.name;
