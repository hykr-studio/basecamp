// What parties hold about a person, for "delete my data" and their data export, and the start-up
// check of the participant roles the application declares.
import { checkParticipantRoles } from '@hykr/contracts';
import { type Conn, entityDefs } from '@hykr/core';
import { events as auditEvents, contacts, participations, parties, partyMembers } from '@hykr/db';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, notExists, or, type SQL, sql } from 'drizzle-orm';
import type { DataSubject, ErasureContributor, ExportContributor } from '../../hooks.js';
import { auditedWith, both } from '../../privacy/contributors.js';
import { emailOf } from '../members/privacy.js';

/**
 * The subject's party member rows: by contact, or by account and by the email an invitation to
 * join was sent to (lower case, as stored), in one business or every one.
 */
const theirs = (a: DataSubject, email: string | null = null): SQL =>
  and(
    a.subject.kind === 'contact'
      ? eq(partyMembers.contactId, a.subject.contactId)
      : or(
          eq(partyMembers.userId, a.subject.userId),
          email ? eq(partyMembers.email, email) : undefined,
        ),
    a.tenantId ? eq(partyMembers.tenantId, a.tenantId) : undefined,
  ) as SQL;

/** What a party member's audit copy (`toMember`) names the subject by. */
const naming = (a: DataSubject, email: string | null): object[] =>
  a.subject.kind === 'contact'
    ? [{ contactId: a.subject.contactId }]
    : [{ userId: a.subject.userId }, ...(email ? [{ email }] : [])];

/** The party a member's audit copy names (`toMember`): its row may be gone. */
const partyOfRow = sql<
  string | null
>`coalesce(${auditEvents.after} ->> 'partyId', ${auditEvents.before} ->> 'partyId')`;

/** This business's audit rows, or every business's (an account forgotten everywhere). */
const inBusiness = (tenantId: string | undefined) =>
  tenantId ? eq(auditEvents.tenantId, tenantId) : undefined;

/** The parties these members were on, from their audit rows: the members may be gone. */
async function partiesOf(
  conn: Conn,
  ids: readonly string[],
  tenantId: string | undefined,
): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await conn
    .selectDistinct({ id: partyOfRow })
    .from(auditEvents)
    .where(
      and(
        inBusiness(tenantId),
        eq(auditEvents.resourceType, 'party_member'),
        inArray(auditEvents.resourceId, [...ids]),
      ),
    );
  return rows.flatMap((r) => (r.id ? [r.id] : []));
}

/**
 * Of these parties, those every member of which, as their audit rows show, was one of `mine`:
 * a party someone else was ever on is not only the subject's (decisions V8).
 */
async function onlyTheirs(
  conn: Conn,
  partyIds: readonly string[],
  mine: ReadonlySet<string>,
  tenantId: string | undefined,
): Promise<string[]> {
  if (!partyIds.length) return [];
  const rows = await conn
    .selectDistinct({ party: partyOfRow, member: auditEvents.resourceId })
    .from(auditEvents)
    .where(
      and(
        inBusiness(tenantId),
        eq(auditEvents.resourceType, 'party_member'),
        inArray(partyOfRow, [...partyIds]),
      ),
    );
  const others = new Set(rows.filter((r) => r.member && !mine.has(r.member)).map((r) => r.party));
  return partyIds.filter((id) => !others.has(id));
}

/** Of these parties, gone already, the person parties (their audit rows say their kind). */
async function personPartiesGone(
  conn: Conn,
  partyIds: readonly string[],
  tenantId: string | undefined,
): Promise<string[]> {
  if (!partyIds.length) return [];
  const live = new Set(
    (
      await conn
        .select({ id: parties.id })
        .from(parties)
        .where(inArray(parties.id, [...partyIds]))
    ).map((p) => p.id),
  );
  const gone = partyIds.filter((id) => !live.has(id));
  if (!gone.length) return [];
  const rows = await conn
    .selectDistinct({ id: auditEvents.resourceId })
    .from(auditEvents)
    .where(
      and(
        inBusiness(tenantId),
        eq(auditEvents.resourceType, 'party'),
        inArray(auditEvents.resourceId, gone),
        sql`coalesce(${auditEvents.after} ->> 'kind', ${auditEvents.before} ->> 'kind') = 'person'`,
      ),
    );
  return rows.flatMap((r) => (r.id ? [r.id] : []));
}

/** The account's email, for a person; none for a contact. */
const emailFor = (a: DataSubject, conn: Conn) =>
  a.subject.kind === 'user' ? emailOf(conn, a.subject.userId) : Promise.resolve(null);

/**
 * Their party memberships go, and invitations to join sent to their email. A person party left
 * with nobody in it goes too, with its participations: it was them. An organisation stays,
 * without them. Their copies (audit rows, replies) lose the person's name, number and email, and
 * the person party's name wherever a participation named it. So do the copies of the members
 * that were them and were taken off before (their audit rows name them), and a person party
 * such a member left empty goes as well, and so do the copies of one deleted before. A person
 * party someone else was ever on (as its members' audit rows show) is not only theirs: it stays,
 * and only their members' copies change (decisions V8).
 */
export const partiesErasure: ErasureContributor = {
  name: 'parties',
  async erase(a) {
    const { tx } = a;
    const email = await emailFor(a, tx);
    const gone = await tx
      .delete(partyMembers)
      .where(theirs(a, email))
      .returning({ id: partyMembers.id, partyId: partyMembers.partyId });
    const now = new Set(gone.map((g) => g.id));
    const earlier = (
      await auditedWith(tx, {
        type: 'party_member',
        contains: naming(a, email),
        tenantId: a.tenantId,
      })
    ).filter((id) => !now.has(id));
    const touched = both(
      gone.map((g) => g.partyId),
      await partiesOf(tx, earlier, a.tenantId),
    );
    if (!touched.length) return { count: 0 };
    const mine = await onlyTheirs(tx, touched, new Set([...now, ...earlier]), a.tenantId);
    const deletedBefore = await personPartiesGone(tx, mine, a.tenantId);
    const empty = and(
      inArray(parties.id, mine),
      eq(parties.kind, 'person'),
      notExists(
        tx
          .select({ id: partyMembers.id })
          .from(partyMembers)
          .where(eq(partyMembers.partyId, parties.id)),
      ),
    ) as SQL;
    // Read before the cascade takes them: the participations copy the party's name. A party
    // deleted before took its participations; their audit rows name it.
    const on = mine.length
      ? await tx
          .select({ id: participations.id })
          .from(participations)
          .innerJoin(parties, eq(parties.id, participations.partyId))
          .where(empty)
      : [];
    const onGone = await auditedWith(tx, {
      type: 'participation',
      contains: deletedBefore.map((partyId) => ({ partyId })),
      tenantId: a.tenantId,
    });
    const emptied = mine.length
      ? await tx.delete(parties).where(empty).returning({ id: parties.id })
      : [];
    return {
      count: gone.length + emptied.length,
      erased: [
        {
          type: 'party_member',
          ids: [...now, ...earlier],
          fields: ['name', 'address', 'email'],
          deleted: true,
        },
        {
          type: 'party',
          ids: both(
            emptied.map((p) => p.id),
            deletedBefore,
          ),
          fields: ['name'],
          deleted: true,
        },
        {
          type: 'participation',
          ids: both(
            on.map((p) => p.id),
            onGone,
          ),
          fields: ['party'],
          deleted: true,
        },
      ],
    };
  },
};

/** Their party memberships, each with its party and the records that party is on. */
export const partiesExport: ExportContributor = {
  name: 'parties',
  async export(a) {
    const rows = await a.db
      .select({ m: partyMembers, party: parties, address: contacts.address })
      .from(partyMembers)
      .innerJoin(parties, eq(parties.id, partyMembers.partyId))
      .leftJoin(contacts, eq(contacts.id, partyMembers.contactId))
      .where(theirs(a, await emailFor(a, a.db)));
    if (!rows.length) return { parties: [] };
    const on = await a.db
      .select()
      .from(participations)
      .where(
        inArray(
          participations.partyId,
          rows.map((r) => r.party.id),
        ),
      );
    return {
      parties: rows.map((r) => ({
        tenantId: r.party.tenantId,
        party: { id: r.party.id, kind: r.party.kind, name: r.party.name },
        member: {
          id: r.m.id,
          name: r.m.name,
          address: r.address,
          email: r.m.email,
          joinedAt: r.m.joinedAt?.toISOString() ?? null,
        },
        participations: on
          .filter((x) => x.partyId === r.party.id)
          .map((x) => ({ resourceType: x.resourceType, resourceId: x.resourceId, role: x.role })),
      })),
    };
  },
};

/** Every participant role names entities this process serves: a mistake stops the start. */
@Injectable()
export class ParticipantRolesCheck implements OnApplicationBootstrap {
  onApplicationBootstrap() {
    checkParticipantRoles(new Set(entityDefs().map((d) => d.name)));
  }
}
