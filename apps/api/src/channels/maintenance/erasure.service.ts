import type { ChannelAdapter } from '@app/channels';
import { type Database, schema, writeAudit } from '@app/db';
import { langOf, t } from '@app/i18n';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';
import { ContactsService } from '../contacts.service.js';
import { WHATSAPP } from '../whatsapp/adapter.provider.js';

const {
  approvals,
  contacts,
  customers,
  inboundEvents,
  linkCodes,
  messages,
  numbers,
  threadMessages,
  threads,
} = schema;
const log = new Logger('Erasure');

/**
 * "Delete my data" (DPDP). Everything that ties the business to this number goes, in one
 * transaction: the contact (and with it consents, messages, handoffs and its own thread), the
 * raw webhook payloads from it on every one of the business's numbers, link codes and their
 * sends, the requests it left waiting for approval, and, for a person with an account, the
 * WhatsApp side of their thread. A customer record stays only as an anonymous business record
 * (their bookings remain the business's); a linked person's account keeps theirs. Audit rows
 * stay and never held the number. They are told once it is done.
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
    const businessNumbers = (
      await this.db
        .select({ id: numbers.phoneNumberId })
        .from(numbers)
        .where(eq(numbers.tenantId, contact.tenantId))
    ).map((n) => n.id);

    await this.db.transaction(async (tx) => {
      if (businessNumbers.length)
        await tx
          .delete(inboundEvents)
          .where(
            and(
              eq(inboundEvents.from, contact.address),
              inArray(inboundEvents.phoneNumberId, businessNumbers),
            ),
          );
      await tx.delete(approvals).where(eq(approvals.requesterContactId, contact.id));
      await tx
        .delete(linkCodes)
        .where(
          and(eq(linkCodes.tenantId, contact.tenantId), eq(linkCodes.address, contact.address)),
        );
      // Sends before they were a contact (a link code) carry the number in their body.
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.tenantId, contact.tenantId),
            isNull(messages.contactId),
            sql`${messages.body}->>'to' = ${contact.address}`,
          ),
        );
      if (contact.userId) {
        // Their account stays; what they said on WhatsApp goes from their shared thread.
        const theirs = tx
          .select({ id: threads.id })
          .from(threads)
          .where(and(eq(threads.tenantId, contact.tenantId), eq(threads.ownerId, contact.userId)));
        await tx
          .delete(threadMessages)
          .where(
            and(inArray(threadMessages.threadId, theirs), eq(threadMessages.channel, 'whatsapp')),
          );
      } else if (contact.customerId) {
        await tx
          .update(customers)
          .set({ displayName: 'Erased customer' })
          .where(eq(customers.id, contact.customerId));
      }
      // Consents, messages, handoffs and the contact's own thread go with it (cascade).
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

    // Done, then said: a failed erasure is retried, never confirmed.
    const from = businessNumbers[0];
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
  }
}
