import type { ChannelAdapter } from '@hykr/channels';
import { type Database, schema } from '@hykr/db';
import { langOf, t } from '@hykr/i18n';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';
import { ContactsService } from '../contacts.service.js';
import { WHATSAPP } from '../whatsapp/adapter.provider.js';
import { type ErasedContact, PRIVACY_INTAKE, type PrivacyIntake } from './erasure.js';

export {
  channelErasure,
  type ErasedContact,
  PRIVACY_INTAKE,
  type PrivacyIntake,
} from './erasure.js';

const { numbers } = schema;
const log = new Logger('Erasure');

/**
 * "Delete my data" on WhatsApp (DPDP). The contact's request is filed with the privacy feature
 * and carried out there and then, in one transaction, unless the business reviews erasures
 * first; then the person is told it is done, or that it was received. A request carried out
 * later is confirmed when it is (`confirm`). A failed erasure is retried, never confirmed.
 */
@Injectable()
export class ErasureService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    private readonly contacts: ContactsService,
    private readonly ref: ModuleRef,
  ) {}

  async erase(contactId: string) {
    const contact = await this.contacts.byId(contactId);
    if (!contact) return;
    const privacy = this.ref.get<PrivacyIntake>(PRIVACY_INTAKE, { strict: false });
    const snapshot: ErasedContact = {
      tenantId: contact.tenantId,
      address: contact.address,
      locale: contact.locale,
    };
    const done = await privacy.eraseContact({ tenantId: contact.tenantId, contactId });
    if (done.status === 'gone') return;
    await this.say(
      snapshot,
      done.status === 'completed' ? 'channel.erased' : 'privacy.erasureReceived',
    );
  }

  /** Tell a forgotten contact it is done. */
  confirm(contact: ErasedContact) {
    return this.say(contact, 'channel.erased');
  }

  private async say(contact: ErasedContact, key: 'channel.erased' | 'privacy.erasureReceived') {
    const [from] = await this.db
      .select({ id: numbers.phoneNumberId })
      .from(numbers)
      .where(eq(numbers.tenantId, contact.tenantId))
      .limit(1);
    if (!from) return;
    await this.wa
      .send(from.id, { kind: 'text', to: contact.address, text: t(langOf(contact.locale), key) })
      .catch((e) =>
        log.warn(`could not confirm the erasure: ${e instanceof Error ? e.message : e}`),
      );
  }
}
