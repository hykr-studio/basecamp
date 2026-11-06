import type { ChannelAdapter, OutboundMessage } from '@hykr/channels';
import type { DocumentChannel, DocumentSendInfo } from '@hykr/contracts';
import { CORE_OPTIONS, type CoreOptions, recordEvents, systemPrincipal } from '@hykr/core';
import {
  contacts,
  customers,
  type Database,
  documentSends,
  documents,
  files,
  messages,
  user,
  writeAudit,
} from '@hykr/db';
import { langOf } from '@hykr/i18n';
import type { Reader } from '@hykr/notifications';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { type Contact, ContactsService } from '../../channels/contacts.service.js';
import { MailerService } from '../../channels/notify/mailer.service.js';
import { OutboundService } from '../../channels/outbound.service.js';
import { TemplateSync } from '../../channels/templates/template-sync.js';
import { WHATSAPP } from '../../channels/whatsapp/adapter.provider.js';
import { config } from '../../config.js';
import { FilesService } from '../files/files.service.js';
import { DocumentEvent, type DocumentRow, type DocumentSendRow, sendInfoOf } from './access.js';
import type { Snapshot } from './commands.js';
import { channelsOf, type DocumentDef, documents as documentDefs } from './define.js';

const log = new Logger('Documents');

/** Who a send reaches, on each channel, and how they read. */
interface Target {
  contact?: Contact;
  email?: string;
  reader: Reader;
}

/** A failure's message, short enough to keep. */
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** "{{name}}" filled from the params: a template's body as a document's caption. */
const fill = (text: string, params: Record<string, string>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '');

/**
 * Sends documents, in the worker (the documents.send queue): by WhatsApp (the PDF uploaded as
 * media, in the document's template with a document header, or as a document message inside the
 * 24-hour window) or by email with the PDF attached, through the channel's own services: consent,
 * template approval, the outbound queue, the mailer.
 */
@Injectable()
export class DocumentSender {
  private readonly db: Database;
  private readonly templates: TemplateSync;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {
    this.db = core.db;
    this.templates = new TemplateSync(this.db, wa, config.appUrl);
  }

  /** The channel's services, looked up when first used. */
  private service<T>(token: new (...args: never[]) => T): T {
    return this.ref.get(token, { strict: false });
  }

  /** Who the recipient is on each channel, and how they read (else the document's language). */
  private async target(doc: DocumentRow, to: Record<string, string>): Promise<Target> {
    const tenantId = doc.tenantId;
    const { business } = doc.data as Snapshot;
    let contact: Contact | undefined;
    let userId: string | null | undefined;
    let email: string | undefined;
    if (to.customerId) {
      const [c] = await this.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, to.customerId), eq(customers.tenantId, tenantId)));
      [contact] = c
        ? await this.db
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, tenantId),
                c.contactId ? eq(contacts.id, c.contactId) : eq(contacts.customerId, c.id),
              ),
            )
            .limit(1)
        : [];
      userId = c?.userId;
    } else if (to.contactId) {
      [contact] = await this.db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, to.contactId), eq(contacts.tenantId, tenantId)));
      userId = contact?.userId;
    } else if (to.userId) {
      userId = to.userId;
      [contact] = await this.db
        .select()
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.userId, to.userId)))
        .orderBy(desc(contacts.linkedAt))
        .limit(1);
    } else if (to.email) email = to.email;
    if (userId && !email) {
      const [person] = await this.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId));
      email = person?.email;
    }
    return {
      contact,
      email,
      reader: {
        lang: contact ? langOf(contact.locale) : langOf(doc.lang),
        timeZone: contact?.timeZone ?? business.timeZone,
      },
    };
  }

  /**
   * By WhatsApp: the PDF uploaded as media, then the template with a document header in the
   * reader's language (or English) when approved, else a document message inside the 24-hour
   * window. Undefined when WhatsApp cannot take it (no contact, unreachable, no consent, no
   * number, no approved template and the window closed).
   */
  private async viaWhatsApp(
    def: DocumentDef,
    doc: DocumentRow,
    send: DocumentSendRow,
    to: Target,
    file: { bytes: Buffer; mime: string },
  ): Promise<{ address: string; messageId: string } | undefined> {
    const how = def.send?.whatsapp;
    const contact = to.contact;
    if (!how || !contact || contact.unreachableAt) return undefined;
    const channel = this.service(ContactsService);
    if (!(await channel.consent(contact.id, 'service'))) return undefined;
    const from = await channel.numberOfTenant(doc.tenantId);
    if (!from) return undefined;
    const template = how.template;
    const lang = (await this.templates.approved(template.name, to.reader.lang))
      ? to.reader.lang
      : (await this.templates.approved(template.name, 'en'))
        ? 'en'
        : undefined;
    if (!lang && !(await channel.windowOpen(contact.id))) return undefined;
    const { value } = doc.data as Snapshot;
    const params = how.params(value, lang ? { ...to.reader, lang } : to.reader);
    const { mediaId } = await this.wa.uploadMedia(from, {
      bytes: file.bytes,
      mime: file.mime,
      filename: doc.fileName,
    });
    const message: OutboundMessage = lang
      ? {
          kind: 'template',
          to: contact.address,
          name: template.name,
          language: lang,
          params,
          header: { kind: 'document', mediaId, filename: doc.fileName },
        }
      : {
          kind: 'document',
          to: contact.address,
          mediaId,
          filename: doc.fileName,
          caption: fill(template.body[to.reader.lang], params),
        };
    const [messageId] = await this.service(OutboundService).queue(
      { tenantId: doc.tenantId, contactId: contact.id, from },
      [message],
      { category: template.category, extra: { document: doc.id, send: send.id } },
    );
    return { address: contact.address, messageId };
  }

  /** By email, the PDF attached. Undefined without an address or email wording. */
  private async viaEmail(
    def: DocumentDef,
    doc: DocumentRow,
    send: DocumentSendRow,
    to: Target,
    file: { bytes: Buffer; mime: string },
  ): Promise<{ address: string; messageId: string } | undefined> {
    const how = def.send?.email;
    if (!how || !to.email) return undefined;
    const { value } = doc.data as Snapshot;
    const messageId = await this.service(MailerService).send(
      { email: to.email, tenantId: doc.tenantId, contactId: to.contact?.id },
      {
        subject: how.subject(value, to.reader),
        text: how.body(value, to.reader),
        attachments: [{ filename: doc.fileName, content: file.bytes, contentType: file.mime }],
      },
      { extra: { document: doc.id, send: send.id } },
    );
    return { address: to.email, messageId };
  }

  /**
   * Deliver one send: when its document is made, by the first channel that takes it (the one
   * asked for, or the document's order). None: failed `unreachable`. On the last try, an error
   * fails it with its message.
   */
  async send(sendId: string, lastTry: boolean): Promise<string> {
    const [send] = await this.db.select().from(documentSends).where(eq(documentSends.id, sendId));
    if (!send || (send.status !== 'queued' && send.status !== 'waiting')) return 'not queued';
    const [doc] = await this.db.select().from(documents).where(eq(documents.id, send.documentId));
    if (!doc) return this.finish(send, 'failed', { error: 'document_gone' });
    if (doc.status === 'failed') return this.finish(send, 'failed', { error: 'document_failed' });
    if (doc.status === 'pending') {
      await this.db
        .update(documentSends)
        .set({ status: 'waiting' })
        .where(and(eq(documentSends.id, send.id), eq(documentSends.status, 'queued')));
      // Made meanwhile (its render may have looked for waiting sends just before): go now.
      const [now] = await this.db
        .select({ status: documents.status })
        .from(documents)
        .where(eq(documents.id, doc.id));
      if (now?.status !== 'ready') return 'waiting';
      await this.db
        .update(documentSends)
        .set({ status: 'queued' })
        .where(and(eq(documentSends.id, send.id), eq(documentSends.status, 'waiting')));
      return this.send(sendId, lastTry);
    }
    const def = documentDefs.get(doc.name);
    try {
      if (!def) throw new Error(`No document "${doc.name}" is declared`);
      if (!doc.fileId) throw new Error('The document has no file');
      const [fileRow] = await this.db.select().from(files).where(eq(files.id, doc.fileId));
      if (!fileRow) throw new Error('The document has no file');
      const file = { bytes: await this.service(FilesService).bytesOf(fileRow), mime: fileRow.mime };
      const to = await this.target(doc, send.recipient);
      const order: DocumentChannel[] = send.channel ? [send.channel] : channelsOf(def);
      for (const channel of order) {
        const done =
          channel === 'whatsapp'
            ? await this.viaWhatsApp(def, doc, send, to, file)
            : await this.viaEmail(def, doc, send, to, file);
        if (done)
          return this.finish(send, 'sent', {
            channel,
            address: done.address,
            messageId: done.messageId,
          });
      }
      return this.finish(send, 'failed', { error: 'unreachable' });
    } catch (e) {
      if (!lastTry) throw e;
      log.error(`send ${send.id} of ${doc.id} failed: ${messageOf(e)}`);
      return this.finish(send, 'failed', { error: messageOf(e) });
    }
  }

  /** A send's outcome: recorded once, audited, and stored as an event. */
  private async finish(
    send: DocumentSendRow,
    status: 'sent' | 'failed',
    a: { channel?: DocumentChannel; address?: string; messageId?: string; error?: string },
  ): Promise<string> {
    await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(documentSends)
        .set({
          status,
          ...(a.channel ? { channel: a.channel } : {}),
          address: a.address ?? null,
          messageId: a.channel === 'whatsapp' ? (a.messageId ?? null) : null,
          error: a.error ?? null,
          ...(status === 'sent' ? { sentAt: new Date() } : {}),
        })
        .where(
          and(eq(documentSends.id, send.id), inArray(documentSends.status, ['queued', 'waiting'])),
        )
        .returning();
      if (!done) return;
      await writeAudit(tx, {
        action: status === 'sent' ? 'document.sent' : 'document.send_failed',
        resourceType: 'document',
        resourceId: send.documentId,
        actorKind: 'system',
        actorId: 'documents.send',
        tenantId: send.tenantId,
        channel: 'background',
        after: {
          send: send.id,
          to: send.recipient,
          channel: done.channel,
          address: done.address,
          ...(done.error ? { error: done.error } : {}),
        },
      });
      await recordEvents(tx, {
        principal: systemPrincipal({ tenantId: send.tenantId, job: 'documents.send' }),
        events: [
          new DocumentEvent(
            status === 'sent' ? 'document.sent' : 'document.send_failed',
            {
              id: done.id,
              tenantId: done.tenantId,
              documentId: done.documentId,
              channel: done.channel,
              status: done.status,
            },
            'documentSend',
          ),
        ],
      });
    });
    return status === 'sent' ? `sent by ${a.channel}` : `failed: ${a.error}`;
  }

  /** A send as `/api/documents` shows it, with WhatsApp's status of its message. */
  async sendInfo(send: DocumentSendRow): Promise<DocumentSendInfo> {
    if (!send.messageId) return sendInfoOf(send);
    const [m] = await this.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, send.messageId));
    return sendInfoOf(send, m?.status ?? null);
  }
}
