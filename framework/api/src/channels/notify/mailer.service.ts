import { type Database, schema } from '@hykr/db';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';

const log = new Logger('Mailer');

/** A file an email carries. */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** A calendar invite the email is (iTIP over email): mail clients show it with their own buttons. */
export interface MailCalendarEvent {
  method: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  filename: string;
  /** The iCalendar text. */
  content: string;
}

/** Email, for notifications WhatsApp can't deliver. Mailpit in development (localhost:8025). */
@Injectable()
export class MailerService implements OnApplicationShutdown {
  private readonly transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
  });

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * One email, recorded as a sent message. Attachments (a document's PDF) go with it; the
   * message row keeps each one's name and size, never its bytes. Returns the message row's id.
   */
  async send(
    to: { email: string; tenantId: string; contactId?: string | null },
    mail: {
      subject: string;
      text: string;
      attachments?: MailAttachment[];
      icalEvent?: MailCalendarEvent;
    },
    meta: { notification?: string; extra?: Record<string, unknown> } = {},
  ): Promise<string> {
    const attachments = mail.attachments ?? [];
    await this.transport.sendMail({
      from: config.smtp.from,
      to: to.email,
      subject: mail.subject,
      text: mail.text,
      ...(attachments.length ? { attachments } : {}),
      ...(mail.icalEvent ? { icalEvent: mail.icalEvent } : {}),
    });
    const [row] = await this.db
      .insert(schema.messages)
      .values({
        tenantId: to.tenantId,
        contactId: to.contactId ?? null,
        channel: 'email',
        direction: 'out',
        kind: attachments.length ? 'media' : 'text',
        body: {
          subject: mail.subject,
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => ({ name: a.filename, size: a.content.length })),
              }
            : {}),
        },
        status: 'sent',
        notification: meta.notification ?? null,
        meta: meta.extra ?? null,
      })
      .returning({ id: schema.messages.id });
    log.log(`emailed ${meta.notification ?? 'a message'}`);
    return row.id;
  }

  onApplicationShutdown() {
    this.transport.close();
  }
}
