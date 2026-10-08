import type { ChannelAdapter } from '@app/channels';
import { type Database, schema, writeAudit } from '@app/db';
import { langOf, t } from '@app/i18n';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';
import { ContactsService } from '../contacts.service.js';
import { WHATSAPP } from '../whatsapp/adapter.provider.js';

const { contacts, customers, inboundEvents, threads, linkCodes } = schema;
const log = new Logger('Erasure');

/**
 * "Delete my data" (DPDP): the contact, their consents, messages, raw webhook payloads and
 * conversation go; their customer record stays only as an anonymous business record (their
 * bookings remain the business's); audit rows stay, and never held the number. They are told
 * first, while there is still a number to tell.
 */
@Injectable()
export class ErasureService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    private readonly contacts: ContactsService,
  ) {}

  async erase(contactId: string) {
    const contact = await this.contacts.byId(contactId);
    if (!contact) return;
    const from = await this.contacts.numberOfTenant(contact.tenantId);
    if (from)
      await this.wa
        .send(from, {
          kind: 'text',
          to: contact.address,
          text: t(langOf(contact.locale), 'channel.erased'),
        })
        .catch((e) =>
          log.warn(`could not confirm the erasure: ${e instanceof Error ? e.message : e}`),
        );

    await this.db.transaction(async (tx) => {
      await tx
        .delete(inboundEvents)
        .where(
          and(
            eq(inboundEvents.from, contact.address),
            from ? eq(inboundEvents.phoneNumberId, from) : undefined,
          ),
        );
      await tx.delete(threads).where(eq(threads.contactId, contact.id));
      await tx
        .delete(linkCodes)
        .where(
          and(eq(linkCodes.tenantId, contact.tenantId), eq(linkCodes.address, contact.address)),
        );
      if (contact.customerId)
        await tx
          .update(customers)
          .set({ displayName: 'Erased customer', userId: null })
          .where(eq(customers.id, contact.customerId));
      // Consents, messages and handoffs go with the contact (cascade).
      await tx.delete(contacts).where(eq(contacts.id, contact.id));
      await writeAudit(tx, {
        action: 'channel.contact.erased',
        resourceType: 'contact',
        resourceId: contact.id,
        actorKind: 'contact',
        actorId: contact.id,
        tenantId: contact.tenantId,
        channel: 'whatsapp',
        reason: 'The person asked to delete their data',
      });
    });
  }
}
