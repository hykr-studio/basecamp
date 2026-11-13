// The parties feature's writes, each a command-shaped WriteOp through runWrite: validated,
// authorized (parties.manage), audited in the transaction with what it touched, and passed through
// the write hooks. None parks; all are people-only routes.
import { randomBytes } from 'node:crypto';
import {
  type AddedPartyMember,
  AddParticipantInput,
  AddPartyMemberInput,
  type AuthorizeResult,
  CreatePartyInput,
  EditPartyInput,
  JoinPartyInput,
  MembersSettings,
  type Participation,
  type Party,
  PartyCapabilities,
  type PartyKind,
  type PartyMember,
  type Principal,
  participationProblem,
} from '@hykr/contracts';
import { allow, deny, type Tx, tenantZoneOf, type WriteOp } from '@hykr/core';
import { contacts, customers, participations, parties, partyMembers, tenants } from '@hykr/db';
import { can } from '@hykr/policy';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { reachable, tokenHash } from '../members/ops.js';

type PartyRow = typeof parties.$inferSelect;
type MemberRow = typeof partyMembers.$inferSelect;
type ParticipationRow = typeof participations.$inferSelect;

const MANAGE = PartyCapabilities.manage.name;

/** A parties write: the WriteOp runWrite takes, with the parts every one of them shares. */
function op<I, L, V>(o: {
  name: string;
  resourceType: string;
  input: z.ZodType<I>;
  resourceId: (input: I, loaded: L) => string | null;
  load: (tx: Tx, p: Principal, input: I) => Promise<L>;
  authorize: (p: Principal, loaded: L, input: I) => AuthorizeResult;
  summarize: (input: I, loaded: L) => string;
  run: WriteOp<I, L, V>['run'];
  args?: Record<string, unknown>;
}): WriteOp<I, L, V> {
  return { kind: 'command', present: (value) => value, ...o };
}

export const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

export const tenantOf = (p: Principal) => {
  if (!p.tenantId) throw notFound('business');
  return p.tenantId;
};

/** Refused unless p manages parties here. */
const manages = (p: Principal, what: string): AuthorizeResult =>
  can(p, MANAGE)
    ? allow('parties_manage', what)
    : deny('parties_manage', 'Only people who manage parties can do this');

/* ── Shapes ───────────────────────────────────────────────────────────────── */

export const toParty = (r: PartyRow): Party => ({
  id: r.id,
  kind: r.kind as PartyKind,
  name: r.name,
  customerId: r.customerId,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toMember = (r: MemberRow, address: string | null = null): PartyMember => ({
  id: r.id,
  partyId: r.partyId,
  name: r.name,
  userId: r.userId,
  contactId: r.contactId,
  address,
  email: r.email,
  expiresAt: r.joinedAt ? null : (r.expiresAt?.toISOString() ?? null),
  joinedAt: r.joinedAt?.toISOString() ?? null,
  addedBy: r.addedBy,
  createdAt: r.createdAt.toISOString(),
});

export const toParticipation = (
  r: ParticipationRow,
  party: { name: string; kind: string },
): Participation => ({
  id: r.id,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  partyId: r.partyId,
  role: r.role,
  party: { name: party.name, kind: party.kind as PartyKind },
  addedBy: r.addedBy,
  createdAt: r.createdAt.toISOString(),
});

/* ── Loading, scoped to the business ─────────────────────────────────────── */

/** A party of p's business, locked for the write: 404 for anything else. */
export async function partyOf(tx: Tx, p: Principal, id: string): Promise<PartyRow> {
  const [row] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, id), eq(parties.tenantId, tenantOf(p))))
    .for('update');
  if (!row) throw notFound('party');
  return row;
}

/** A customer record of p's business, or 404. */
async function customerOf(tx: Tx, p: Principal, id: string) {
  const [row] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.tenantId, tenantOf(p))));
  if (!row) throw notFound('customer');
}

/* ── Parties ──────────────────────────────────────────────────────────────── */

export const createParty = () =>
  op({
    name: 'parties.create',
    resourceType: 'party',
    input: CreatePartyInput,
    resourceId: () => null,
    async load(tx, p, input) {
      tenantOf(p);
      if (input.customerId) await customerOf(tx, p, input.customerId);
      return null;
    },
    authorize: (p) => manages(p, 'Adds a party'),
    summarize: (input) => `Add ${input.kind} ${input.name}`,
    async run({ tx, principal, input }) {
      const [row] = await tx
        .insert(parties)
        .values({
          tenantId: tenantOf(principal),
          kind: input.kind,
          name: input.name,
          customerId: input.customerId ?? null,
          createdBy: principal.actor.id,
        })
        .returning();
      const party = toParty(row);
      return {
        value: party,
        touched: [{ type: 'party', id: row.id, change: 'created', after: party }],
      };
    },
  });

export const editParty = (id: string) =>
  op({
    name: 'parties.edit',
    resourceType: 'party',
    input: EditPartyInput,
    args: { id },
    resourceId: () => id,
    async load(tx, p, input) {
      const row = await partyOf(tx, p, id);
      if (input.customerId) await customerOf(tx, p, input.customerId);
      return row;
    },
    authorize: (p) => manages(p, 'Changes a party'),
    summarize: (_i, row) => `Change ${row.name}`,
    async run({ tx, input, loaded }) {
      const [row] = await tx
        .update(parties)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        })
        .where(eq(parties.id, loaded.id))
        .returning();
      const after = toParty(row);
      return {
        value: after,
        touched: [{ type: 'party', id, change: 'updated', before: toParty(loaded), after }],
      };
    },
  });

/** A party goes with its members and its participations (cascade). */
export const removeParty = (id: string) =>
  op({
    name: 'parties.remove',
    resourceType: 'party',
    input: z.object({}).strict(),
    args: { id },
    resourceId: () => id,
    load: (tx, p) => partyOf(tx, p, id),
    authorize: (p) => manages(p, 'Removes a party'),
    summarize: (_i, row) => `Remove ${row.name}`,
    async run({ tx, loaded }) {
      await tx.delete(parties).where(eq(parties.id, loaded.id));
      return {
        value: { removed: true },
        touched: [{ type: 'party', id, change: 'deleted', before: toParty(loaded) }],
      };
    },
  });

/* ── Members ──────────────────────────────────────────────────────────────── */

/** How long an email invitation can be accepted: the business's members setting (A4's). */
async function inviteDays(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const raw = (row?.settings ?? {}) as Record<string, unknown>;
  return MembersSettings.parse(raw.members).inviteDays;
}

/**
 * Reach a party's person by their WhatsApp number (the business's contact for it, made without
 * a customer record when new), or invite them by email to join with an account (the token in the
 * answer, once). One number or account once per party.
 */
export const addMember = (partyId: string) =>
  op<AddPartyMemberInput, PartyRow, AddedPartyMember>({
    name: 'parties.members.add',
    resourceType: 'party_member',
    input: AddPartyMemberInput,
    args: { partyId },
    resourceId: () => null,
    load: (tx, p) => partyOf(tx, p, partyId),
    authorize: (p) => manages(p, "Adds a party's person"),
    summarize: (input, party) =>
      input.address ? `Reach ${party.name} on WhatsApp` : `Invite ${input.email} to ${party.name}`,
    async run({ tx, principal, input, loaded: party }) {
      const tenantId = tenantOf(principal);
      if (input.address) {
        // The business's contact for the number: as it is, or new (no customer record).
        await tx
          .insert(contacts)
          .values({
            tenantId,
            channel: 'whatsapp',
            address: input.address,
            profileName: input.name,
            timeZone: await tenantZoneOf(tx, tenantId),
          })
          .onConflictDoNothing();
        const [contact] = await tx
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.tenantId, tenantId),
              eq(contacts.channel, 'whatsapp'),
              eq(contacts.address, input.address),
            ),
          );
        const [created] = await tx
          .insert(partyMembers)
          .values({
            tenantId,
            partyId: party.id,
            name: input.name ?? contact.profileName,
            contactId: contact.id,
            joinedAt: new Date(),
            addedBy: principal.actor.id,
          })
          .onConflictDoNothing()
          .returning();
        const [row] = created
          ? [created]
          : await tx
              .select()
              .from(partyMembers)
              .where(
                and(eq(partyMembers.partyId, party.id), eq(partyMembers.contactId, contact.id)),
              );
        const member = toMember(row, contact.address);
        return {
          value: { member },
          touched: created
            ? [{ type: 'party_member', id: row.id, change: 'created', after: member }]
            : [],
        };
      }
      const token = randomBytes(32).toString('base64url');
      const days = await inviteDays(tx, tenantId);
      const [row] = await tx
        .insert(partyMembers)
        .values({
          tenantId,
          partyId: party.id,
          name: input.name ?? null,
          email: (input.email ?? '').toLowerCase(),
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
          addedBy: principal.actor.id,
        })
        .returning();
      const member = toMember(row);
      // The token is in the answer only: the audit row and the database keep its hash.
      return {
        value: { member, token },
        touched: [{ type: 'party_member', id: row.id, change: 'created', after: member }],
      };
    },
  });

/** A member of a party of p's business, locked, with its number; or 404. */
async function memberOf(tx: Tx, p: Principal, partyId: string, id: string) {
  const [m] = await tx
    .select()
    .from(partyMembers)
    .where(
      and(
        eq(partyMembers.id, id),
        eq(partyMembers.partyId, partyId),
        eq(partyMembers.tenantId, tenantOf(p)),
      ),
    )
    .for('update');
  if (!m) throw notFound('member');
  const [contact] = m.contactId
    ? await tx
        .select({ address: contacts.address })
        .from(contacts)
        .where(eq(contacts.id, m.contactId))
    : [];
  return { m, address: contact?.address ?? null };
}

export const removeMember = (partyId: string, id: string) =>
  op({
    name: 'parties.members.remove',
    resourceType: 'party_member',
    input: z.object({}).strict(),
    args: { partyId, id },
    resourceId: () => id,
    load: (tx, p) => memberOf(tx, p, partyId, id),
    authorize: (p) => manages(p, "Removes a party's person"),
    summarize: () => "Remove a party's person",
    async run({ tx, loaded: { m, address } }) {
      await tx.delete(partyMembers).where(eq(partyMembers.id, m.id));
      return {
        value: { removed: true },
        touched: [{ type: 'party_member', id, change: 'deleted', before: toMember(m, address) }],
      };
    },
  });

/**
 * Join a party with an emailed link: p acts in the party's business (the controller makes it
 * so, with no roles there) and becomes the member. Already that party's member by account: the
 * invitation is used up and the membership stands. Never a membership of the business.
 */
export const joinParty = (memberId: string) =>
  op({
    name: 'parties.join',
    resourceType: 'party_member',
    input: JoinPartyInput,
    resourceId: () => memberId,
    async load(tx, _p, input) {
      const [row] = await tx
        .select()
        .from(partyMembers)
        .where(
          and(eq(partyMembers.id, memberId), eq(partyMembers.tokenHash, tokenHash(input.token))),
        )
        .for('update');
      if (!row || row.joinedAt || !row.expiresAt || row.expiresAt.getTime() <= Date.now())
        throw new NotFoundException({
          error: 'not_found',
          message: 'This invitation is not valid any more',
        });
      return row;
    },
    authorize: () => allow('party_invite_accepted', 'Joins the party it was invited to'),
    summarize: () => 'Join a party',
    async run({ tx, principal, loaded: invite }) {
      const userId = principal.actor.id;
      const [already] = await tx
        .select()
        .from(partyMembers)
        .where(and(eq(partyMembers.partyId, invite.partyId), eq(partyMembers.userId, userId)));
      if (already) {
        await tx.delete(partyMembers).where(eq(partyMembers.id, invite.id));
        return {
          value: { member: toMember(already), tenantId: invite.tenantId },
          touched: [
            { type: 'party_member', id: invite.id, change: 'deleted', before: toMember(invite) },
          ],
        };
      }
      const [row] = await tx
        .update(partyMembers)
        .set({ userId, joinedAt: new Date(), tokenHash: null })
        .where(eq(partyMembers.id, invite.id))
        .returning();
      const member = toMember(row);
      return {
        value: { member, tenantId: invite.tenantId },
        touched: [
          {
            type: 'party_member',
            id: invite.id,
            change: 'updated',
            before: toMember(invite),
            after: member,
          },
        ],
      };
    },
  });

/* ── Participations ───────────────────────────────────────────────────────── */

/**
 * Put a party on a record in a participant role: the role is declared, fits the party's kind and
 * the record's entity, and p reaches the record. The same (record, party, role) twice is the one.
 */
export const addParticipant = () =>
  op({
    name: 'participants.add',
    resourceType: 'participation',
    input: AddParticipantInput,
    resourceId: () => null,
    async load(tx, p, input) {
      const party = await partyOf(tx, p, input.partyId);
      await reachable(tx, p, input.resourceType, input.resourceId);
      const problem = participationProblem(input.role, party, input.resourceType);
      if (problem) throw new BadRequestException({ error: 'bad_participant', reason: problem });
      return party;
    },
    authorize: (p) => manages(p, 'Puts a party on a record'),
    summarize: (input, party) => `Put ${party.name} on this ${input.resourceType} as ${input.role}`,
    async run({ tx, principal, input, loaded: party }) {
      const values = { tenantId: tenantOf(principal), ...input, addedBy: principal.actor.id };
      const [created] = await tx
        .insert(participations)
        .values(values)
        .onConflictDoNothing()
        .returning();
      const [row] = created
        ? [created]
        : await tx
            .select()
            .from(participations)
            .where(
              and(
                eq(participations.tenantId, values.tenantId),
                eq(participations.resourceType, input.resourceType),
                eq(participations.resourceId, input.resourceId),
                eq(participations.partyId, input.partyId),
                eq(participations.role, input.role),
              ),
            );
      const participation = toParticipation(row, party);
      return {
        value: participation,
        touched: created
          ? [{ type: 'participation', id: row.id, change: 'created', after: participation }]
          : [],
      };
    },
  });

export const removeParticipant = (id: string) =>
  op({
    name: 'participants.remove',
    resourceType: 'participation',
    input: z.object({}).strict(),
    args: { id },
    resourceId: () => id,
    async load(tx, p) {
      const [x] = await tx
        .select()
        .from(participations)
        .where(and(eq(participations.id, id), eq(participations.tenantId, tenantOf(p))))
        .for('update');
      if (!x) throw notFound('participation');
      const [party] = await tx
        .select({ name: parties.name, kind: parties.kind })
        .from(parties)
        .where(eq(parties.id, x.partyId));
      await reachable(tx, p, x.resourceType, x.resourceId);
      return { x, name: party?.name ?? '', kind: party?.kind ?? 'person' };
    },
    authorize: (p) => manages(p, 'Takes a party off a record'),
    summarize: (_i, row) => `Take ${row.name} off this ${row.x.resourceType}`,
    async run({ tx, loaded: row }) {
      await tx.delete(participations).where(eq(participations.id, row.x.id));
      return {
        value: { removed: true },
        touched: [
          { type: 'participation', id, change: 'deleted', before: toParticipation(row.x, row) },
        ],
      };
    },
  });
