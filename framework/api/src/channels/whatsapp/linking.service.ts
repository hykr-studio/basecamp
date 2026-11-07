import type { Principal } from '@hykr/contracts';
import { type Database, schema, writeAudit } from '@hykr/db';
import type { Lang } from '@hykr/i18n';
import { LoginCode } from '@hykr/notifications';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';
import { ContactsService } from '../contacts.service.js';
import { OTP_TTL_MS, OtpService } from '../otp/otp.service.js';
import { OtpSender } from '../otp/sender.js';

const { contacts, customers, memberships } = schema;

/** What a linking code is for (`OtpService`'s purpose: its limits count apart from others'). */
export const LINK_PURPOSE = 'channel.link';

/**
 * Linking a WhatsApp number to an account, by a one-time code sent to that number (the
 * login_code_v1 template): proof the person holds the number. Once linked, messages from it act
 * as them, at WhatsApp's assurance; their customer records, if any, become theirs. The codes are
 * `OtpService`'s (decisions B8, 12): 10 minutes, 5 attempts, 5 an hour per account and per number.
 */
@Injectable()
export class LinkingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly otp: OtpService,
    private readonly sender: OtpSender,
  ) {}

  async sendCode(p: Principal, address: string, timeZone: string, lang: Lang) {
    const tenantId = p.tenantId ?? '';
    const taken = await this.contacts.byAddress(tenantId, address);
    if (taken?.userId && taken.userId !== p.actor.id)
      throw new ConflictException('That number is linked to another account');
    const { row, code } = await this.otp.createAndIssue({
      tenantId,
      purpose: LINK_PURPOSE,
      subject: { userId: p.actor.id },
      channel: 'whatsapp',
      address,
      meta: { timeZone },
    });
    await this.sender.whatsapp(row, code, { lang, template: LoginCode, contactId: taken?.id });
    return { sentTo: address, expiresInSeconds: OTP_TTL_MS / 1000 };
  }

  async verify(p: Principal, address: string, code: string) {
    const tenantId = p.tenantId ?? '';
    const noCode = () => new BadRequestException('No code waiting for that number: send a new one');
    const pending = await this.otp.latest({
      tenantId,
      purpose: LINK_PURPOSE,
      subject: { userId: p.actor.id },
      address,
    });
    if (!pending) throw noCode();
    const outcome = await this.otp.verify(pending, code);
    if (outcome === 'wrong') throw new BadRequestException("That code isn't right");
    if (outcome !== 'ok') throw noCode();
    const zone = (pending.meta as { timeZone?: string } | null)?.timeZone ?? 'UTC';
    return this.link(p.actor.id, tenantId, address, zone);
  }

  /** The number is theirs: one number per person per business, and one customer record. */
  private async link(userId: string, tenantId: string, address: string, timeZone: string) {
    const contact = await this.contacts.findOrCreate(tenantId, address);
    await this.db.transaction(async (tx) => {
      // Lock both: two links at once must not split a customer in two.
      await tx.execute(sql`select 1 from channel.contacts where id = ${contact.id} for update`);
      await tx
        .update(contacts)
        .set({ userId: null, linkedAt: null })
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.userId, userId)));
      await tx
        .update(contacts)
        .set({ userId, timeZone, linkedAt: new Date() })
        .where(eq(contacts.id, contact.id));
      await this.mergeCustomers(tx, tenantId, userId, contact.customerId);
      await writeAudit(tx, {
        action: 'channel.contact.linked',
        resourceType: 'contact',
        resourceId: contact.id,
        actorKind: 'user',
        actorId: userId,
        tenantId,
        channel: 'whatsapp',
        reason: 'Linked with a one-time code sent to the number',
      });
    });
    return { address, timeZone };
  }

  /**
   * If the person is already this business's customer under their account, the number's
   * customer record joins it: every business table's customer_id moves over (whatever the
   * domain), and the contact points at the one record left.
   */
  private async mergeCustomers(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    tenantId: string,
    userId: string,
    fromCustomer: string | null,
  ) {
    if (!fromCustomer) return;
    const [member] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    const into = member?.customerId;
    if (!into) {
      // Their customer record is this one now.
      await tx.update(customers).set({ userId }).where(eq(customers.id, fromCustomer));
      if (member)
        await tx
          .update(memberships)
          .set({ customerId: fromCustomer })
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
      return;
    }
    if (into === fromCustomer) return;
    const { rows } = await tx.execute<{ table_name: string }>(sql`
      select table_name from information_schema.columns
      where table_schema = 'app' and column_name = 'customer_id' and table_name <> 'customers'
        and table_name <> 'memberships'`);
    for (const { table_name } of rows)
      await tx.execute(
        sql`update ${sql.identifier('app')}.${sql.identifier(table_name)} set customer_id = ${into}
            where customer_id = ${fromCustomer} and tenant_id = ${tenantId}`,
      );
    await tx
      .update(contacts)
      .set({ customerId: into })
      .where(eq(contacts.customerId, fromCustomer));
    await tx.delete(customers).where(eq(customers.id, fromCustomer));
  }
}
