import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@app/contracts';
import { type Database, schema, writeAudit } from '@app/db';
import type { Lang } from '@app/i18n';
import { LoginCode } from '@app/notifications';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { ContactsService } from '../contacts.service.js';
import { OutboundService } from '../outbound.service.js';

const { linkCodes, contacts, customers, memberships } = schema;

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const hash = (id: string, code: string) =>
  createHash('sha256').update(`${id}:${code}`).digest('hex');

/**
 * Linking a WhatsApp number to an account, by a one-time code sent to that number (the
 * login_code_v1 template): proof the person holds the number. Once linked, messages from it act
 * as them, at WhatsApp's assurance; their customer records, if any, become theirs.
 */
@Injectable()
export class LinkingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly outbound: OutboundService,
  ) {}

  async sendCode(p: Principal, address: string, timeZone: string, lang: Lang) {
    const tenantId = p.tenantId ?? '';
    const taken = await this.contacts.byAddress(tenantId, address);
    if (taken?.userId && taken.userId !== p.actor.id)
      throw new ConflictException('That number is linked to another account');
    // At most 5 codes an hour per account, and per number whoever asks: codes cost money and
    // land on someone's phone.
    const [recent] = await this.db
      .select({
        mine: sql<number>`count(*) filter (where ${linkCodes.userId} = ${p.actor.id})::int`,
        toNumber: sql<number>`count(*) filter (where ${linkCodes.address} = ${address})::int`,
      })
      .from(linkCodes)
      .where(gt(linkCodes.createdAt, sql`now() - interval '1 hour'`));
    if ((recent?.mine ?? 0) >= MAX_CODES_PER_HOUR || (recent?.toNumber ?? 0) >= MAX_CODES_PER_HOUR)
      throw new HttpException('Too many codes: try again later', HttpStatus.TOO_MANY_REQUESTS);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const [row] = await this.db
      .insert(linkCodes)
      .values({
        userId: p.actor.id,
        tenantId,
        address,
        timeZone,
        codeHash: 'pending',
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      })
      .returning();
    await this.db
      .update(linkCodes)
      .set({ codeHash: hash(row.id, code) })
      .where(eq(linkCodes.id, row.id));
    const from = (await this.contacts.numberOfTenant(tenantId)) ?? config.whatsapp.phoneNumberId;
    await this.outbound.queue(
      { tenantId, contactId: taken?.id ?? null, from },
      [{ kind: 'template', to: address, name: LoginCode.name, language: lang, params: { code } }],
      { category: 'authentication' },
    );
    return { sentTo: address, expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  async verify(p: Principal, address: string, code: string) {
    const tenantId = p.tenantId ?? '';
    const [pending] = await this.db
      .select()
      .from(linkCodes)
      .where(
        and(
          eq(linkCodes.userId, p.actor.id),
          eq(linkCodes.tenantId, tenantId),
          eq(linkCodes.address, address),
          isNull(linkCodes.consumedAt),
          gt(linkCodes.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(linkCodes.createdAt))
      .limit(1);
    const noCode = () => new BadRequestException('No code waiting for that number: send a new one');
    if (!pending) throw noCode();
    // Every guess spends an attempt first, in one statement: parallel guesses can't all slip
    // under the limit.
    const [spent] = await this.db
      .update(linkCodes)
      .set({ attempts: sql`${linkCodes.attempts} + 1` })
      .where(
        and(
          eq(linkCodes.id, pending.id),
          isNull(linkCodes.consumedAt),
          lt(linkCodes.attempts, MAX_ATTEMPTS),
        ),
      )
      .returning({ id: linkCodes.id });
    if (!spent) throw noCode();
    const expected = Buffer.from(pending.codeHash);
    const given = Buffer.from(hash(pending.id, code));
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new BadRequestException("That code isn't right");
    // Used once: a second correct guess racing this one finds it consumed.
    const [consumed] = await this.db
      .update(linkCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(linkCodes.id, pending.id), isNull(linkCodes.consumedAt)))
      .returning({ id: linkCodes.id });
    if (!consumed) throw noCode();
    return this.link(p.actor.id, tenantId, address, pending.timeZone);
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
