import { type Lang, t } from '@hykr/i18n';
import type { TemplateDef } from '@hykr/notifications';
import { Injectable } from '@nestjs/common';
import { config } from '../../config.js';
import { ContactsService } from '../contacts.service.js';
import { MailerService } from '../notify/mailer.service.js';
import { OutboundService } from '../outbound.service.js';
import { OTP_TTL_MS, type OtpRow } from './otp.service.js';

/**
 * Delivers one-time codes: on WhatsApp as an authentication template (the code its only
 * parameter), through the outbound queue like every message; by email through the mailer. The
 * code itself is never stored here: the WhatsApp message carries it as the template's parameter.
 */
@Injectable()
export class OtpSender {
  constructor(
    private readonly contacts: ContactsService,
    private readonly outbound: OutboundService,
    private readonly mailer: MailerService,
  ) {}

  /** The code by WhatsApp, as this template, from the business's number. */
  async whatsapp(
    row: OtpRow,
    code: string,
    // biome-ignore lint/suspicious/noExplicitAny: an authentication template of any params
    a: { lang: Lang; template: TemplateDef<any>; contactId?: string | null },
  ): Promise<void> {
    const from =
      (await this.contacts.numberOfTenant(row.tenantId)) ?? config.whatsapp.phoneNumberId;
    await this.outbound.queue(
      { tenantId: row.tenantId, contactId: a.contactId ?? row.contactId ?? null, from },
      [
        {
          kind: 'template',
          to: row.address,
          name: a.template.name,
          language: a.lang,
          params: { code },
        },
      ],
      { category: 'authentication' },
    );
  }

  /** The code by email, in the framework's words (`otp.email.*`). */
  async email(row: OtpRow, code: string, a: { lang: Lang; business: string }): Promise<void> {
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    const minutes = Math.max(1, Math.round((ttl > 0 ? ttl : OTP_TTL_MS) / 60_000));
    await this.mailer.send(
      { email: row.address, tenantId: row.tenantId, contactId: row.contactId },
      {
        subject: t(a.lang, 'otp.email.subject', { business: a.business }),
        text: t(a.lang, 'otp.email.body', { code, business: a.business, minutes }),
      },
      { notification: row.purpose },
    );
  }
}
