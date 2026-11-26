// Who a data subject is in one business: the ids their personal data is filed under. Nothing here
// loads Nest.
import { type PrivacyFor, type Subject, subjectKey } from '@hykr/contracts';
import type { Conn } from '@hykr/core';
import { contacts, customers, memberships, partyMembers, user } from '@hykr/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

/** A person, or a WhatsApp contact, in one business, with every id their data is kept under. */
export interface Identities {
  tenantId: string;
  subject: Subject;
  /** Their account, for a person. */
  userId: string | null;
  /** Their WhatsApp contacts here: the contact itself, or the numbers linked to the account. */
  contactIds: string[];
  /** Their customer records here. */
  customerIds: string[];
  /** Every subject key they act as: 'user:<id>', 'contact:<id>'. */
  keys: string[];
}

const uniq = (xs: readonly (string | null | undefined)[]) =>
  [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.length > 0))].sort();

/**
 * The person's ids in this business, or null when the business does not know them: no
 * membership, customer record, contact or party membership for an account; no contact of this
 * business for a contact.
 */
export async function identitiesOf(
  conn: Conn,
  tenantId: string,
  subject: Subject,
): Promise<Identities | null> {
  if (subject.kind === 'contact') {
    const [c] = await conn
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, subject.contactId), eq(contacts.tenantId, tenantId)));
    if (!c) return null;
    const theirs = await conn
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.contactId, c.id)));
    return {
      tenantId,
      subject,
      userId: null,
      contactIds: [c.id],
      customerIds: uniq([c.customerId, ...theirs.map((r) => r.id)]),
      keys: [subjectKey(subject)],
    };
  }
  const userId = subject.userId;
  const [member] = await conn
    .select({ customerId: memberships.customerId })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
  const linked = await conn
    .select({ id: contacts.id, customerId: contacts.customerId })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.userId, userId)));
  const contactIds = linked.map((c) => c.id);
  const asCustomer = await conn
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        contactIds.length
          ? sql`(${customers.userId} = ${userId} or ${inArray(customers.contactId, contactIds)})`
          : eq(customers.userId, userId),
      ),
    );
  const [party] = await conn
    .select({ id: partyMembers.id })
    .from(partyMembers)
    .where(and(eq(partyMembers.tenantId, tenantId), eq(partyMembers.userId, userId)))
    .limit(1);
  if (!member && !linked.length && !asCustomer.length && !party) return null;
  return {
    tenantId,
    subject,
    userId,
    contactIds,
    customerIds: uniq([
      member?.customerId,
      ...linked.map((c) => c.customerId),
      ...asCustomer.map((c) => c.id),
    ]),
    keys: [subjectKey(subject), ...contactIds.map((id) => `contact:${id}`)],
  };
}

/** Someone a request is for, as the business knows them; null when it does not. */
export async function subjectFor(
  conn: Conn,
  tenantId: string,
  who: PrivacyFor,
): Promise<Subject | null> {
  if ('userId' in who) return { kind: 'user', userId: who.userId };
  if ('contactId' in who) return { kind: 'contact', contactId: who.contactId };
  if ('email' in who) {
    const [u] = await conn
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${who.email.trim().toLowerCase()}`);
    return u ? { kind: 'user', userId: u.id } : null;
  }
  const address = who.address.replace(/^\+/, '');
  const [c] = await conn
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.address, address)));
  return c ? { kind: 'contact', contactId: c.id } : null;
}

/** The same person? */
export const sameSubject = (a: Subject | null | undefined, b: Subject | null | undefined) =>
  !!a && !!b && subjectKey(a) === subjectKey(b);

/** A request's subject columns as a Subject. */
export const subjectOfRow = (r: { subjectKind: string; subjectId: string }): Subject =>
  r.subjectKind === 'contact'
    ? { kind: 'contact', contactId: r.subjectId }
    : { kind: 'user', userId: r.subjectId };
