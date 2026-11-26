import { and, asc, desc, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../database.js';
import { contacts } from '../schema/channel.js';
import { participations, partyMembers } from '../schema/parties.js';
import { customers, memberships, tenants } from '../schema/tenancy.js';

/**
 * The party members that are this person: joined with their account, or a WhatsApp contact their
 * account is linked to (in that contact's business). A pending invitation is nobody yet.
 */
export function personMembers(db: DbOrTx, userId: string): SQL {
  const linked = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.tenantId, partyMembers.tenantId)));
  return or(
    and(eq(partyMembers.userId, userId), isNotNull(partyMembers.joinedAt)),
    inArray(partyMembers.contactId, linked),
  ) as SQL;
}

/** Is this person a member of one of this business's parties? Then they participate in it. */
export async function participatesIn(
  db: DbOrTx,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: partyMembers.id })
    .from(partyMembers)
    .where(and(eq(partyMembers.tenantId, tenantId), personMembers(db, userId)))
    .limit(1);
  return Boolean(row);
}

/** The business where this person most recently became a party member, if any. */
export async function latestParticipation(db: DbOrTx, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ tenantId: partyMembers.tenantId })
    .from(partyMembers)
    .where(personMembers(db, userId))
    .orderBy(desc(partyMembers.joinedAt), desc(partyMembers.createdAt))
    .limit(1);
  return row?.tenantId;
}

/** The customer record that is this person's in this business, if any. */
export async function customerOfUser(
  db: DbOrTx,
  userId: string,
  tenantId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.userId, userId)))
    .limit(1);
  return row?.id;
}

/** One business a person is in, as the switcher lists it. */
export type PersonBusiness = {
  tenantId: string;
  name: string;
  as: 'member' | 'participant';
  /** A member's roles; empty for a participant (the resolver gives them theirs). */
  roles: string[];
  /** The participant roles the person's parties hold there. */
  participantRoles: string[];
  isDefault: boolean;
};

/**
 * Every business this person is in: as a member (their membership, roles and default), and as a
 * participant where they are no member (a party member there). Members first, by default then
 * name; then participant businesses by name.
 */
export async function businessesOf(db: DbOrTx, userId: string): Promise<PersonBusiness[]> {
  const member = await db
    .select({
      tenantId: memberships.tenantId,
      name: tenants.name,
      roles: memberships.roles,
      isDefault: memberships.isDefault,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(memberships.isDefault), asc(tenants.name));
  const memberOf = new Set(member.map((m) => m.tenantId));

  const parts = await db
    .select({ tenantId: partyMembers.tenantId, name: tenants.name })
    .from(partyMembers)
    .innerJoin(tenants, eq(tenants.id, partyMembers.tenantId))
    .where(personMembers(db, userId));
  const outside = [...new Map(parts.map((p) => [p.tenantId, p])).values()].filter(
    (p) => !memberOf.has(p.tenantId),
  );
  const roles = outside.length
    ? await db
        .select({ tenantId: participations.tenantId, role: participations.role })
        .from(participations)
        .innerJoin(partyMembers, eq(partyMembers.partyId, participations.partyId))
        .where(
          and(
            inArray(
              participations.tenantId,
              outside.map((p) => p.tenantId),
            ),
            personMembers(db, userId),
          ),
        )
    : [];
  return [
    ...member.map((m) => ({
      tenantId: m.tenantId,
      name: m.name,
      as: 'member' as const,
      roles: m.roles,
      participantRoles: [],
      isDefault: m.isDefault,
    })),
    ...outside
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        tenantId: p.tenantId,
        name: p.name,
        as: 'participant' as const,
        roles: [],
        participantRoles: [
          ...new Set(roles.filter((r) => r.tenantId === p.tenantId).map((r) => r.role)),
        ].sort(),
        isDefault: false,
      })),
  ];
}
