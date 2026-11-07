// The people a notification addressed to a party (or to everyone on a record) reaches: each joined
// member of the party, as a person (their account) or a contact (their number). Only in the
// notification's business.
import { type Database, schema } from '@hykr/db';
import type { Recipient } from '@hykr/notifications';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';

const { contacts, participations, partyMembers, parties } = schema;

type PartyRecipient = Extract<Recipient, { partyId: string } | { participantsOf: unknown }>;
type Person = { userId: string } | { contactId: string };

/**
 * Each person of the party, or of every party on the record (in the roles `as` names), each once:
 * a person by account; a number by its contact, unless the number is linked to a person already
 * reached. A pending invitation reaches nobody.
 */
export async function partiesTo(
  db: Database,
  tenantId: string,
  r: PartyRecipient,
): Promise<Person[]> {
  const partyIds =
    'partyId' in r
      ? [r.partyId]
      : (
          await db
            .select({ id: participations.partyId })
            .from(participations)
            .where(
              and(
                eq(participations.tenantId, tenantId),
                eq(participations.resourceType, r.participantsOf.type),
                eq(participations.resourceId, r.participantsOf.id),
                r.as ? inArray(participations.role, r.as) : undefined,
              ),
            )
        ).map((x) => x.id);
  if (!partyIds.length) return [];
  const rows = await db
    .select({
      userId: partyMembers.userId,
      contactId: partyMembers.contactId,
      linkedTo: contacts.userId,
      createdAt: partyMembers.createdAt,
    })
    .from(partyMembers)
    .innerJoin(parties, eq(parties.id, partyMembers.partyId))
    .leftJoin(contacts, eq(contacts.id, partyMembers.contactId))
    .where(
      and(
        eq(partyMembers.tenantId, tenantId),
        eq(parties.tenantId, tenantId),
        inArray(partyMembers.partyId, [...new Set(partyIds)]),
        or(isNotNull(partyMembers.joinedAt), isNotNull(partyMembers.contactId)),
      ),
    )
    .orderBy(partyMembers.createdAt);
  const people = new Set(rows.flatMap((x) => (x.userId ? [x.userId] : [])));
  const out: Person[] = [];
  const seen = new Set<string>();
  for (const x of rows) {
    if (x.userId) {
      if (seen.has(x.userId)) continue;
      seen.add(x.userId);
      out.push({ userId: x.userId });
    } else if (x.contactId) {
      // A number linked to a person this already reaches: once, as the person.
      if (x.linkedTo && people.has(x.linkedTo)) continue;
      if (seen.has(`contact:${x.contactId}`)) continue;
      seen.add(`contact:${x.contactId}`);
      out.push({ contactId: x.contactId });
    }
  }
  return out;
}
