import { type Database, schema } from '@app/db';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';

const log = new Logger('Mailer');

/** Email, for notifications WhatsApp can't deliver. Mailpit in development (localhost:8025). */
@Injectable()
export class MailerService implements OnApplicationShutdown {
  private readonly transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
  });

  constructor(@Inject(DB) private readonly db: Database) {}

  async send(
    to: { email: string; tenantId: string; contactId?: string | null },
    mail: { subject: string; text: string },
    meta: { notification?: string } = {},
  ) {
    await this.transport.sendMail({ from: config.smtp.from, to: to.email, ...mail });
    await this.db.insert(schema.messages).values({
      tenantId: to.tenantId,
      contactId: to.contactId ?? null,
      channel: 'email',
      direction: 'out',
      kind: 'text',
      body: { subject: mail.subject },
      status: 'sent',
      notification: meta.notification ?? null,
    });
    log.log(`emailed ${meta.notification ?? 'a message'}`);
  }

  onApplicationShutdown() {
    this.transport.close();
  }
}
