import {
  type DocumentRecipient,
  FrameworkCapabilities,
  type Principal,
  parseTenantSettings,
  RenderDocumentSpec,
  SendDocumentSpec,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  allow,
  type ChildEntityDef,
  type Conn,
  defineCommand,
  deny,
  entityDef,
  needsApproval,
  projectRead,
  type Tx,
  toJson,
} from '@hykr/core';
import {
  contacts,
  customers,
  documentSends,
  documents,
  memberships,
  tenants,
  user,
} from '@hykr/db';
import { type Lang, localeOf, moneyText, pick } from '@hykr/i18n';
import { can, subjectOf } from '@hykr/policy';
import { NotFoundException } from '@nestjs/common';
import { and, eq, max, sql } from 'drizzle-orm';
import {
  DocumentEvent,
  type DocumentRow,
  eventRowOf,
  infoOf,
  reachable,
  seenAsOf,
  sendInfoOf,
} from './access.js';
import {
  channelsOf,
  type DocumentBusiness,
  type DocumentDef,
  type DocumentRenderContext,
  documents as documentDefs,
  pdfName,
} from './define.js';
import { type CheckedLayout, DocumentLayout } from './layout.js';

type Values = Record<string, unknown>;

/** What a document's data is stored as: the business it was made in, and what `load` read. */
export interface Snapshot {
  business: DocumentBusiness;
  value: unknown;
}

/** The business's name and time zone. */
export async function businessOf(conn: Conn, tenantId: string): Promise<DocumentBusiness> {
  const [t] = await conn
    .select({ name: tenants.name, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!t) throw new NotFoundException({ error: 'not_found', message: 'No such business' });
  return { id: tenantId, name: t.name, timeZone: parseTenantSettings(t.settings).timeZone };
}

/** The layout a definition gives for this data, checked (a template's mistake throws). */
export function layoutOf(
  def: DocumentDef,
  value: unknown,
  lang: Lang,
  business: DocumentBusiness,
): CheckedLayout {
  const ctx: DocumentRenderContext = {
    lang,
    business,
    label: (labels) => pick(labels, lang),
    money: (m) => moneyText(m, lang),
    date: (v, options = { day: 'numeric', month: 'long', year: 'numeric' }) =>
      new Intl.DateTimeFormat(localeOf(lang), { ...options, timeZone: business.timeZone }).format(
        new Date(v),
      ),
  };
  const parsed = DocumentLayout.safeParse(def.render(value, ctx));
  if (!parsed.success)
    throw new Error(`Document ${def.name} laid out a page wrong: ${parsed.error.message}`);
  return parsed.data;
}

const notReached = (label: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${label}` });

/* ── document.render ───────────────────────────────────────────────────────── */

interface RenderLoaded {
  def: DocumentDef;
  entity: AnyEntityDef;
  record: Values;
  business: DocumentBusiness;
}

/**
 * document.render: a new version of a record's document. Its data is read here, as the person,
 * in this transaction, and stored with it; the worker draws the pages from that (decisions B2).
 */
export const RenderDocument = defineCommand(RenderDocumentSpec, {
  resource: { type: 'document', id: () => null },
  load: async (tx, p, input): Promise<RenderLoaded> => {
    const def = documentDefs.get(input.document);
    const entity = def ? entityDef(def.entity) : undefined;
    if (!def || !entity)
      throw new NotFoundException({ error: 'not_found', message: 'No such document' });
    if (p.actor.kind === 'agent' && entity.spec.expose.get !== 'all')
      throw notReached(entity.spec.label);
    const row = await entity.repo.find(tx, p, input.id);
    if (!row) throw notReached(entity.spec.label);
    const record = toJson(entity.toRead(row, p)) as Values;
    return { def, entity, record, business: await businessOf(tx, p.tenantId ?? '') };
  },
  authorize: (p, { def, record }) =>
    def.authorize?.render?.(p, record) ??
    allow('may_make_document', 'Whoever reads a record may make its documents'),
  summarize: (input, { def, entity }) =>
    `Make ${pick(def.label, 'en')} for ${entity.spec.label} ${input.id}`,
  run: async ({ tx, principal: p, input, loaded }) => {
    const { def, entity, record, business } = loaded;
    const lang: Lang = input.lang ?? 'en';
    const read = async (other: AnyEntityDef, id: string) => {
      if (p.actor.kind === 'agent' && other.spec.expose.get !== 'all') return null;
      const row = await other.repo.find(tx, p, id);
      return row ? (toJson(other.toRead(row, p)) as Values) : null;
    };
    // biome-ignore lint/suspicious/noExplicitAny: any child entity
    const children = async (child: ChildEntityDef<any, any>, parentId = input.id) =>
      (await child.children.list(tx, p, parentId)).map((r) => toJson(child.toRead(r, p)) as Values);
    const loadedValue = await def.load({
      tx,
      principal: p,
      id: input.id,
      lang,
      record,
      business,
      read,
      children,
    });
    // JSON only: what is stored is exactly what the worker draws from.
    const value = JSON.parse(JSON.stringify(loadedValue ?? null)) as unknown;
    layoutOf(def, value, lang, business);
    const snapshot: Snapshot = { business, value };

    const subject = subjectOf(p);
    // One version number per record and document, even when two ask at once.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`documents:${p.tenantId}:${def.name}:${entity.name}:${input.id}`}))`,
    );
    const [{ last }] = await tx
      .select({ last: max(documents.version) })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, p.tenantId ?? ''),
          eq(documents.name, def.name),
          eq(documents.resourceType, entity.name),
          eq(documents.resourceId, input.id),
        ),
      );
    const [row] = await tx
      .insert(documents)
      .values({
        tenantId: p.tenantId ?? '',
        name: def.name,
        resourceType: entity.name,
        resourceId: input.id,
        version: (last ?? 0) + 1,
        lang,
        status: 'pending',
        data: snapshot,
        seenAs: seenAsOf(p),
        requestedBy: subject?.kind === 'user' ? subject.userId : null,
        requestedByContact: subject?.kind === 'contact' ? subject.contactId : null,
        createdBy: p.actor.kind === 'agent' ? 'assistant' : 'person',
        fileName: pdfName(def.fileName(value as never, lang)),
      })
      .returning();
    const event = eventRowOf(row);
    return {
      value: row,
      touched: [{ type: 'document', id: row.id, change: 'created', after: event }],
      events: [new DocumentEvent('document.requested', event)],
    };
  },
  present: (row: DocumentRow, p) => projectRead('document', infoOf(row) as unknown as Values, p),
});

/* ── document.send ─────────────────────────────────────────────────────────── */

/** A recipient as stored: `{ self: true }` resolved to the principal's own subject. */
type Resolved = Exclude<DocumentRecipient, { self: true }>;

/** The recipient, checked in the business; whether it is the principal themself. */
async function recipientOf(
  tx: Tx,
  p: Principal,
  to: DocumentRecipient,
): Promise<{ label: string; self: boolean; to: Resolved }> {
  const tenantId = p.tenantId ?? '';
  const subject = subjectOf(p);
  const missing = () => new NotFoundException({ error: 'not_found', message: 'No such recipient' });
  if ('self' in to) {
    if (subject?.kind === 'user')
      return { label: 'you', self: true, to: { userId: subject.userId } };
    if (subject?.kind === 'contact')
      return { label: 'you', self: true, to: { contactId: subject.contactId } };
    throw missing();
  }
  if ('customerId' in to) {
    const [c] = await tx
      .select({
        name: customers.displayName,
        userId: customers.userId,
        contactId: customers.contactId,
      })
      .from(customers)
      .where(and(eq(customers.id, to.customerId), eq(customers.tenantId, tenantId)));
    if (!c) throw missing();
    const self =
      (subject?.kind === 'user' && c.userId === subject.userId) ||
      (subject?.kind === 'contact' && c.contactId === subject.contactId);
    return { label: c.name, self, to };
  }
  if ('contactId' in to) {
    const [c] = await tx
      .select({ name: contacts.profileName, userId: contacts.userId })
      .from(contacts)
      .where(and(eq(contacts.id, to.contactId), eq(contacts.tenantId, tenantId)));
    if (!c) throw missing();
    const self =
      (subject?.kind === 'contact' && subject.contactId === to.contactId) ||
      (subject?.kind === 'user' && c.userId === subject.userId);
    return { label: c.name ?? 'a contact', self, to };
  }
  if ('userId' in to) {
    const [m] = await tx
      .select({ name: user.name })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, to.userId)));
    if (!m) throw missing();
    return { label: m.name, self: subject?.kind === 'user' && subject.userId === to.userId, to };
  }
  return { label: to.email, self: false, to };
}

interface SendLoaded {
  doc: DocumentRow;
  def: DocumentDef;
  recipient: { label: string; self: boolean; to: Resolved };
}

/**
 * document.send: one document to one recipient, by WhatsApp or email. The send is recorded here;
 * the worker delivers it once the document is made (decisions B2).
 */
export const SendDocument = defineCommand(SendDocumentSpec, {
  resource: { type: 'document', id: (input) => input.documentId },
  load: async (tx, p, input): Promise<SendLoaded> => {
    const { row, def } = await reachable(tx, p, input.documentId);
    return { doc: row, def, recipient: await recipientOf(tx, p, input.to) };
  },
  authorize: (p, { doc, def, recipient }, input) => {
    if (doc.status === 'failed') return deny('document_failed', 'This document could not be made');
    const channels = channelsOf(def);
    if (!channels.length) return deny('not_sendable', 'This document cannot be sent');
    if (input.channel && !channels.includes(input.channel))
      return deny('channel_unavailable', `This document is not sent by ${input.channel}`);
    const own = def.authorize?.send?.(p, {
      document: {
        id: doc.id,
        name: doc.name,
        resourceType: doc.resourceType,
        resourceId: doc.resourceId,
      },
      to: recipient.to,
    });
    if (own) return own;
    if (recipient.self)
      return allow('send_to_self', 'Whoever reads a document may send it to themselves');
    if (!can(p, FrameworkCapabilities.messageCustomers))
      return deny('cannot_send_to_others', 'Only the business sends documents to others');
    if (p.actor.kind === 'agent')
      return needsApproval(
        'agent_sends_document',
        'Sending a document for you needs your approval',
      );
    return allow('person_sends_document', 'The business sends its documents');
  },
  summarize: (input, { doc, recipient }) =>
    `Send ${doc.fileName} to ${recipient.label}${input.channel ? ` by ${input.channel}` : ''}`,
  run: async ({ tx, principal: p, input, loaded }) => {
    const subject = subjectOf(p);
    const [row] = await tx
      .insert(documentSends)
      .values({
        tenantId: p.tenantId ?? '',
        documentId: loaded.doc.id,
        recipient: loaded.recipient.to as Record<string, string>,
        channel: input.channel ?? null,
        status: loaded.doc.status === 'ready' ? 'queued' : 'waiting',
        requestedBy: subject?.kind === 'user' ? subject.userId : null,
      })
      .returning();
    return {
      value: row,
      touched: [],
      events: [
        new DocumentEvent(
          'document.send_requested',
          { id: row.id, tenantId: row.tenantId, documentId: row.documentId },
          'documentSend',
        ),
      ],
    };
  },
  present: (row, p) => projectRead('documentSend', sendInfoOf(row) as unknown as Values, p),
});
