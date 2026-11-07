// The WhatsApp channel's part of forgetting a contact, and what it asks of the privacy feature.
// Nothing here loads Nest or reads the configuration: the privacy feature imports it at load time.
import { schema } from '@hykr/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ErasureContributor } from '../../hooks.js';

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
/** What a customer record no account holds is called once its contact is forgotten. */
const ERASED_CUSTOMER = 'Erased customer';

/**
 * What the WhatsApp channel keeps about a contact besides the contact row: the raw webhook
 * payloads from its number on every one of the business's numbers, the requests it left waiting
 * for approval, link codes and sends made to the number before it was a contact, and, for a
 * number linked to an account, the WhatsApp side of that person's thread. A customer record no
 * account holds is anonymised (the business's bookings stay its own). The contact row itself
 * (with its consents, messages, handoffs and own thread) goes last, after every other
 * contributor, in the privacy feature's erasure. Audit rows stay and never held the number.
 */
export const channelErasure: ErasureContributor = {
  name: 'channel',
  async erase({ subject, tenantId, tx }) {
    if (subject.kind !== 'contact') return { count: 0 };
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.id, subject.contactId),
          tenantId ? eq(contacts.tenantId, tenantId) : undefined,
        ),
      );
    if (!contact) return { count: 0 };
    const businessNumbers = (
      await tx
        .select({ id: numbers.phoneNumberId })
        .from(numbers)
        .where(eq(numbers.tenantId, contact.tenantId))
    ).map((n) => n.id);
    let n = 0;
    if (businessNumbers.length)
      n += (
        await tx
          .delete(inboundEvents)
          .where(
            and(
              eq(inboundEvents.from, contact.address),
              inArray(inboundEvents.phoneNumberId, businessNumbers),
            ),
          )
          .returning({ id: inboundEvents.id })
      ).length;
    n += (
      await tx
        .delete(approvals)
        .where(eq(approvals.requesterContactId, contact.id))
        .returning({ id: approvals.id })
    ).length;
    n += (
      await tx
        .delete(linkCodes)
        .where(
          and(eq(linkCodes.tenantId, contact.tenantId), eq(linkCodes.address, contact.address)),
        )
        .returning({ id: linkCodes.id })
    ).length;
    // Sends before they were a contact (a link code) carry the number in their body.
    n += (
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.tenantId, contact.tenantId),
            isNull(messages.contactId),
            sql`${messages.body}->>'to' = ${contact.address}`,
          ),
        )
        .returning({ id: messages.id })
    ).length;
    if (contact.userId) {
      // Their account stays; what they said on WhatsApp goes from their shared thread.
      const theirs = tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.tenantId, contact.tenantId), eq(threads.ownerId, contact.userId)));
      n += (
        await tx
          .delete(threadMessages)
          .where(
            and(inArray(threadMessages.threadId, theirs), eq(threadMessages.channel, 'whatsapp')),
          )
          .returning({ id: threadMessages.id })
      ).length;
    } else if (contact.customerId) {
      n += (
        await tx
          .update(customers)
          .set({ displayName: ERASED_CUSTOMER })
          .where(eq(customers.id, contact.customerId))
          .returning({ id: customers.id })
      ).length;
    }
    return { count: n };
  },
};

/** What a confirmation needs, read before the contact is gone. */
export interface ErasedContact {
  tenantId: string;
  address: string;
  locale: string;
}

/** What the privacy feature does for a WhatsApp "delete my data" (features/privacy). */
export interface PrivacyIntake {
  /**
   * File the contact's erasure (intake `whatsapp`) and carry it out now, unless the business
   * reviews erasures first ('waiting'). 'gone': there is no such contact any more.
   */
  eraseContact(a: {
    tenantId: string;
    contactId: string;
  }): Promise<{ status: 'completed' | 'waiting' | 'gone' }>;
}

/** Its token: the privacy feature provides it; the channel asks for it when it needs it. */
export const PRIVACY_INTAKE = Symbol('PRIVACY_INTAKE');
