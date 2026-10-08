import { type Database, schema } from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB } from '../infra/db.module.js';

const { contacts, customers, numbers, consents, messages } = schema;
export type Contact = typeof contacts.$inferSelect;

/** The 24-hour customer-service window: free-form replies only while it is open. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Contacts: the bridge between a phone number and the principals the rest of the system
 * knows. A new number becomes a customer of the business it wrote to; policy never sees the
 * number, only the principal built from the contact.
 */
@Injectable()
export class ContactsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The business a WhatsApp number belongs to. */
  async tenantOfNumber(phoneNumberId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ tenantId: numbers.tenantId })
      .from(numbers)
      .where(eq(numbers.phoneNumberId, phoneNumberId));
    return row?.tenantId;
  }

  /** The number this business sends from (its first, for now). */
  async numberOfTenant(tenantId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: numbers.phoneNumberId })
      .from(numbers)
      .where(eq(numbers.tenantId, tenantId))
      .limit(1);
    return row?.id;
  }

  /** Make this number the business's (moving it from any other). */
  async claimNumber(phoneNumberId: string, tenantId: string, displayName?: string) {
    await this.db
      .insert(numbers)
      .values({ phoneNumberId, tenantId, displayName })
      .onConflictDoUpdate({ target: numbers.phoneNumberId, set: { tenantId, displayName } });
  }

  async byId(id: string): Promise<Contact | undefined> {
    const [row] = await this.db.select().from(contacts).where(eq(contacts.id, id));
    return row;
  }

  async byAddress(tenantId: string, address: string): Promise<Contact | undefined> {
    const [row] = await this.db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.channel, 'whatsapp'),
          eq(contacts.address, address),
        ),
      );
    return row;
  }

  /**
   * The contact for a sender, created on their first message as the business's customer
   * (a customer record, with service consent: they wrote to us). Safe under concurrency: the
   * unique address index makes a second insert a lookup.
   */
  async findOrCreate(tenantId: string, address: string, profileName?: string): Promise<Contact> {
    const found = await this.byAddress(tenantId, address);
    if (found) {
      if (profileName && profileName !== found.profileName)
        await this.db.update(contacts).set({ profileName }).where(eq(contacts.id, found.id));
      return found;
    }
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(contacts)
        .values({ tenantId, channel: 'whatsapp', address, profileName })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const [existing] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.tenantId, tenantId), eq(contacts.address, address)));
        return existing;
      }
      const [customer] = await tx
        .insert(customers)
        .values({ tenantId, displayName: profileName || `+${address}`, contactId: created.id })
        .returning();
      await tx.insert(consents).values({
        contactId: created.id,
        topic: 'service',
        granted: true,
        source: 'inbound_message',
      });
      const [linked] = await tx
        .update(contacts)
        .set({ customerId: customer.id })
        .where(eq(contacts.id, created.id))
        .returning();
      return linked;
    });
  }

  async markWelcomed(id: string) {
    await this.db.update(contacts).set({ welcomedAt: new Date() }).where(eq(contacts.id, id));
  }

  /** When the contact last wrote to us: the 24-hour window runs from here. */
  async lastInboundAt(contactId: string): Promise<Date | undefined> {
    const [row] = await this.db
      .select({ at: messages.at })
      .from(messages)
      .where(and(eq(messages.contactId, contactId), eq(messages.direction, 'in')))
      .orderBy(desc(messages.at))
      .limit(1);
    return row?.at;
  }

  async windowOpen(contactId: string, now = Date.now()): Promise<boolean> {
    const at = await this.lastInboundAt(contactId);
    return at !== undefined && now - at.getTime() < WINDOW_MS;
  }

  /** The latest consent per topic: granted or not, and the default when there is none. */
  async consent(contactId: string, topic: 'service' | 'reminders' | 'marketing') {
    const [row] = await this.db
      .select({ granted: consents.granted })
      .from(consents)
      .where(and(eq(consents.contactId, contactId), eq(consents.topic, topic)))
      .orderBy(desc(consents.at), desc(consents.id))
      .limit(1);
    // Service and reminders about their own records are on until they say STOP; marketing
    // only ever with an explicit yes.
    return row ? row.granted : topic !== 'marketing';
  }

  /** A changed consent: a new row (the table is append-only). */
  async setConsent(
    contactId: string,
    topic: 'service' | 'reminders' | 'marketing',
    granted: boolean,
    source: string,
  ) {
    await this.db.insert(consents).values({ contactId, topic, granted, source });
  }

  async markUnreachable(contactId: string, unreachable: boolean) {
    await this.db
      .update(contacts)
      .set({ unreachableAt: unreachable ? sql`now()` : null })
      .where(eq(contacts.id, contactId));
  }
}
