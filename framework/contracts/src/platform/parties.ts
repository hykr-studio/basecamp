// The parties API (/api/parties, /api/participants): the people and organisations a business
// works with, how each is reached, and who participates in which record. Served by @hykr/api's
// `parties` feature; people only, every write audited.
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import { PARTY_KINDS, type PartyKind } from '../parties.js';
import { ROLE_NAME } from '../principal.js';

/** One way a party is reached: a WhatsApp number, a person's account, or an invitation by email. */
export type PartyMember = {
  id: string;
  partyId: string;
  /** What the business calls this person. */
  name: string | null;
  /** The person's account, once they joined (or the account a linked number belongs to). */
  userId: string | null;
  /** The business's WhatsApp contact for this person. */
  contactId: string | null;
  /** The contact's number (E.164 digits, no +). */
  address: string | null;
  /** An invitation's address, until it is accepted. */
  email: string | null;
  /** When an invitation runs out; null once joined, or for a number. */
  expiresAt: string | null;
  joinedAt: string | null;
  addedBy: string;
  createdAt: string;
};

/** A person or organisation the business works with. */
export type Party = {
  id: string;
  kind: PartyKind;
  name: string;
  /** The customer record it belongs to (several people of one customer). */
  customerId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** With `GET /api/parties/:id`. */
  members?: PartyMember[];
};

/** A party on a record, in a participant role. */
export type Participation = {
  id: string;
  resourceType: string;
  resourceId: string;
  partyId: string;
  role: string;
  party: { name: string; kind: PartyKind };
  addedBy: string;
  createdAt: string;
};

/** A participant role as a picker shows it. */
export type ParticipantRoleView = {
  name: string;
  label: Labels;
  kinds: PartyKind[];
  /** The entities it applies to; null: every entity. */
  on: string[] | null;
};

const name = z.string().trim().min(1).max(200);
const id = z.string().min(1).max(100);
/** A WhatsApp number: E.164 digits, no + (the channel's address). */
export const WhatsAppAddress = z.string().regex(/^[1-9]\d{6,14}$/, 'E.164 digits, no +');

export const CreatePartyInput = z.object({
  kind: z.enum(PARTY_KINDS),
  name,
  customerId: id.nullable().optional(),
});
export type CreatePartyInput = z.input<typeof CreatePartyInput>;

export const EditPartyInput = z
  .object({ name: name.optional(), customerId: id.nullable().optional() })
  .refine((v) => v.name !== undefined || v.customerId !== undefined, 'Send a name or a customer');
export type EditPartyInput = z.input<typeof EditPartyInput>;

/**
 * Reach a party's person by their WhatsApp number (`address`), or invite them by email to join
 * with an account (`email`): one of the two.
 */
export const AddPartyMemberInput = z
  .object({
    address: WhatsAppAddress.optional(),
    email: z.email().max(320).optional(),
    name: name.optional(),
  })
  .strict()
  .refine(
    (v) => (v.address === undefined) !== (v.email === undefined),
    'Send a WhatsApp number (address) or an email, not both',
  );
export type AddPartyMemberInput = z.input<typeof AddPartyMemberInput>;

/** The answer to adding a member: an email invitation's token, once (never shown again). */
export type AddedPartyMember = { member: PartyMember; token?: string };

export const JoinPartyInput = z.object({ token: z.string().min(16).max(200) });
export type JoinPartyInput = z.infer<typeof JoinPartyInput>;

export const PartiesQuery = z.object({
  kind: z.enum(PARTY_KINDS).optional(),
  customerId: id.optional(),
  q: z.string().max(200).optional(),
});
export type PartiesQuery = z.infer<typeof PartiesQuery>;

export const AddParticipantInput = z.object({
  resourceType: z.string().min(1).max(100),
  resourceId: id,
  partyId: id,
  role: z.string().regex(ROLE_NAME),
});
export type AddParticipantInput = z.infer<typeof AddParticipantInput>;

export const ParticipantsQuery = z.object({
  resourceType: z.string().min(1).max(100),
  resourceId: id,
});
export type ParticipantsQuery = z.infer<typeof ParticipantsQuery>;

export const SetDefaultBusinessInput = z.object({ tenantId: id });
export type SetDefaultBusinessInput = z.infer<typeof SetDefaultBusinessInput>;
