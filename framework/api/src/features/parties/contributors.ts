// What parties hold about a person, for "delete my data" and their data export, and the start-up
// check of the participant roles the application declares.
import { checkParticipantRoles } from '@hykr/contracts';
import { entityDefs } from '@hykr/core';
import { contacts, participations, parties, partyMembers } from '@hykr/db';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, notExists, type SQL } from 'drizzle-orm';
import type { DataSubject, ErasureContributor, ExportContributor } from '../../hooks.js';

/** The subject's party member rows: by contact, or by account (in one business, or every one). */
const theirs = (a: DataSubject): SQL =>
  and(
    a.subject.kind === 'contact'
      ? eq(partyMembers.contactId, a.subject.contactId)
      : eq(partyMembers.userId, a.subject.userId),
    a.tenantId ? eq(partyMembers.tenantId, a.tenantId) : undefined,
  ) as SQL;

/**
 * Their party memberships go. A person party left with nobody in it goes too, with its
 * participations: it was them. An organisation stays, without them.
 */
export const partiesErasure: ErasureContributor = {
  name: 'parties',
  async erase(a) {
    const { tx } = a;
    const gone = await tx
      .delete(partyMembers)
      .where(theirs(a))
      .returning({ partyId: partyMembers.partyId });
    const touched = [...new Set(gone.map((g) => g.partyId))];
    if (!touched.length) return { count: 0 };
    const emptied = await tx
      .delete(parties)
      .where(
        and(
          inArray(parties.id, touched),
          eq(parties.kind, 'person'),
          notExists(
            tx
              .select({ id: partyMembers.id })
              .from(partyMembers)
              .where(eq(partyMembers.partyId, parties.id)),
          ),
        ),
      )
      .returning({ id: parties.id });
    return { count: gone.length + emptied.length };
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
      .where(theirs(a));
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
