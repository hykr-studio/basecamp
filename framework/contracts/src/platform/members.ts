// The members API (/api/members, /api/grants): a business's people, its roles, invitations and
// per-record grants. Served by @hykr/api's `members` feature; people only, every write audited.
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import { ROLE_NAME } from '../principal.js';
import { CAPABILITY_NAME } from '../roles.js';
import { BusinessLabel, type RoleView } from '../settings/roles.js';

const RoleName = z.string().regex(ROLE_NAME);
const Roles = z.array(RoleName).min(1).max(20);

/** A person in the business, with their roles there. */
export type Member = {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  /** Set when they are this business's customer. */
  customerId: string | null;
  joinedAt: string;
};

/** A capability as the role editor shows it. */
export type CapabilityView = {
  name: string;
  label: Labels;
  /** False: only the application's code gives it; a business cannot add it to a role. */
  grantable: boolean;
};

/** The business's roles and the capabilities it can build them from. */
export type BusinessRoles = { roles: RoleView[]; capabilities: CapabilityView[] };

/** An invitation to join the business, as its managers see it (the token is never shown again). */
export type Invite = {
  id: string;
  email: string;
  roles: string[];
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

/** One person's access to one record (an access rule's `granted` reach). */
export type RecordGrant = {
  id: string;
  resourceType: string;
  resourceId: string;
  userId: string;
  grantedBy: string;
  createdAt: string;
};

export const SetMemberRolesInput = z.object({ roles: Roles });
export type SetMemberRolesInput = z.infer<typeof SetMemberRolesInput>;

export const DefineRoleInput = z.object({
  name: RoleName,
  label: BusinessLabel,
  capabilities: z.array(z.string().regex(CAPABILITY_NAME)).max(200),
});
export type DefineRoleInput = z.input<typeof DefineRoleInput>;

/**
 * A change to a role. For one the business made: a new label or capabilities. For a declared
 * one: the business's own label or capabilities; `null` goes back to the application's.
 */
export const EditRoleInput = z
  .object({
    label: BusinessLabel.nullable().optional(),
    capabilities: z.array(z.string().regex(CAPABILITY_NAME)).max(200).nullable().optional(),
  })
  .refine(
    (v) => v.label !== undefined || v.capabilities !== undefined,
    'Send a label or capabilities',
  );
export type EditRoleInput = z.input<typeof EditRoleInput>;

export const CreateInviteInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  roles: Roles,
});
export type CreateInviteInput = z.input<typeof CreateInviteInput>;

/** What creating an invitation returns, once: the token goes in the link the inviter shares. */
export type CreatedInvite = { invite: Invite; token: string };

export const AcceptInviteInput = z.object({ token: z.string().min(20).max(200) });
export type AcceptInviteInput = z.infer<typeof AcceptInviteInput>;

/** Joining: the business, and the roles held there now. */
export type AcceptedInvite = { tenantId: string; roles: string[] };

export const AddGrantInput = z.object({
  resourceType: z.string().min(1).max(64),
  resourceId: z.uuid(),
  userId: z.string().min(1).max(64),
});
export type AddGrantInput = z.infer<typeof AddGrantInput>;

export const GrantsQuery = z.object({
  resourceType: z.string().min(1).max(64),
  resourceId: z.uuid(),
});
export type GrantsQuery = z.infer<typeof GrantsQuery>;
