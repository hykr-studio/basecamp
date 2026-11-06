// The members feature's writes, each a command-shaped WriteOp through runWrite: validated,
// authorized (members.manage or records.grant), audited in the transaction with what it
// touched, and passed through the write hooks. None parks; all are people-only routes.
import { createHash, randomBytes } from 'node:crypto';
import {
  AcceptInviteInput,
  AddGrantInput,
  type AuthorizeResult,
  CreateInviteInput,
  capabilityProblem,
  DefineRoleInput,
  declaredCapabilities,
  roles as declaredRoles,
  EditRoleInput,
  FrameworkCapabilities,
  type Invite,
  MembersSettings,
  type Principal,
  type RecordGrant,
  RolesSettings,
  type RoleView,
  rolesOfBusiness,
  SetMemberRolesInput,
  standingIn,
} from '@hykr/contracts';
import { allow, type Conn, deny, entityDef, type Tx, type WriteOp } from '@hykr/core';
import { memberInvites, memberships, recordGrants, tenants } from '@hykr/db';
import { can } from '@hykr/policy';
import { NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

type Values = Record<string, unknown>;
type Settings = { roles: RolesSettings; members: MembersSettings; raw: Values };

const MANAGE = FrameworkCapabilities.manageMembers;
const GRANT = FrameworkCapabilities.grantRecords;

/** A members write: the WriteOp runWrite takes, with the parts every one of them shares. */
function op<I, L, V>(o: {
  name: string;
  resourceType: string;
  input: z.ZodType<I>;
  resourceId: (input: I, loaded: L) => string | null;
  load: (tx: Tx, p: Principal, input: I) => Promise<L>;
  authorize: (p: Principal, loaded: L, input: I) => AuthorizeResult;
  summarize: (input: I, loaded: L) => string;
  run: WriteOp<I, L, V>['run'];
  args?: Values;
}): WriteOp<I, L, V> {
  return { kind: 'command', present: (value) => value, ...o };
}

const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

const tenantOf = (p: Principal) => {
  if (!p.tenantId) throw notFound('business');
  return p.tenantId;
};

/** Refused unless p manages members here. */
const manages = (p: Principal): AuthorizeResult | null =>
  can(p, MANAGE)
    ? null
    : deny('members_manage', 'Only people who manage members and roles can do this');

/** The business's settings, locked for this write: roles, members, and the stored JSON. */
async function lockSettings(tx: Tx, tenantId: string): Promise<Settings> {
  const [row] = await tx
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update');
  if (!row) throw notFound('business');
  const raw = (row.settings && typeof row.settings === 'object' ? row.settings : {}) as Values;
  return {
    raw,
    roles: RolesSettings.parse(raw.roles),
    members: MembersSettings.parse(raw.members),
  };
}

async function saveRoles(tx: Tx, tenantId: string, s: Settings, next: RolesSettings) {
  await tx
    .update(tenants)
    .set({ settings: { ...s.raw, roles: next } })
    .where(eq(tenants.id, tenantId));
}

/** Every member's roles here. */
async function rolesByMember(tx: Tx, tenantId: string): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ userId: memberships.userId, roles: memberships.roles })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));
  return new Map(rows.map((r) => [r.userId, r.roles]));
}

/**
 * How many members would still manage members after a change (new roles per member, new role
 * definitions). Zero would lock the business out of its own roles.
 */
function managersAfter(members: Map<string, string[]>, rolesSettings: RolesSettings): number {
  let n = 0;
  for (const held of members.values())
    if (standingIn(held, { roles: rolesSettings }).capabilities.includes(MANAGE.name)) n++;
  return n;
}

const lastManager = deny(
  'last_manager',
  'Someone in the business must still be able to manage members and roles',
);

/** Role names this business does not have. */
const unknownRoles = (names: readonly string[], rolesSettings: RolesSettings) =>
  standingIn(names, { roles: rolesSettings }).unknown;

const roleView = (name: string, rolesSettings: RolesSettings): RoleView | undefined =>
  rolesOfBusiness({ roles: rolesSettings }).find((r) => r.name === name);

/* ── Members ──────────────────────────────────────────────────────────────── */

type MemberRow = typeof memberships.$inferSelect;

async function memberOf(tx: Tx, tenantId: string, userId: string): Promise<MemberRow> {
  const [row] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
  if (!row) throw notFound('member');
  return row;
}

const membershipJson = (m: MemberRow) => ({
  tenantId: m.tenantId,
  userId: m.userId,
  roles: m.roles,
  customerId: m.customerId,
});

export const setMemberRoles = (userId: string) =>
  op({
    name: 'members.roles',
    resourceType: 'membership',
    input: SetMemberRolesInput,
    args: { userId },
    resourceId: () => userId,
    async load(tx, p, input) {
      const tenantId = tenantOf(p);
      const member = await memberOf(tx, tenantId, userId);
      const { roles } = await lockSettings(tx, tenantId);
      const members = await rolesByMember(tx, tenantId);
      members.set(userId, input.roles);
      return {
        member,
        unknown: unknownRoles(input.roles, roles),
        managers: managersAfter(members, roles),
      };
    },
    authorize: (p, l) =>
      manages(p) ??
      (l.unknown.length
        ? deny('unknown_role', `This business has no role ${l.unknown.join(', ')}`)
        : l.managers === 0
          ? lastManager
          : allow('members_manage', 'Changes the roles of a member')),
    summarize: (input) => `Give a member the roles ${input.roles.join(', ')}`,
    async run({ tx, input, loaded: { member } }) {
      const [after] = await tx
        .update(memberships)
        .set({ roles: [...new Set(input.roles)] })
        .where(and(eq(memberships.tenantId, member.tenantId), eq(memberships.userId, userId)))
        .returning();
      return {
        value: membershipJson(after),
        touched: [
          {
            type: 'membership',
            id: userId,
            change: 'updated',
            before: membershipJson(member),
            after: membershipJson(after),
          },
        ],
      };
    },
  });

export const removeMember = (userId: string) =>
  op({
    name: 'members.remove',
    resourceType: 'membership',
    input: z.object({}).strict(),
    args: { userId },
    resourceId: () => userId,
    async load(tx, p) {
      const tenantId = tenantOf(p);
      const member = await memberOf(tx, tenantId, userId);
      const { roles } = await lockSettings(tx, tenantId);
      const [tenant] = await tx
        .select({ owner: tenants.defaultOwnerId })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      const members = await rolesByMember(tx, tenantId);
      members.delete(userId);
      return {
        member,
        defaultOwner: tenant?.owner === userId,
        managers: managersAfter(members, roles),
      };
    },
    authorize: (p, l) =>
      manages(p) ??
      (l.defaultOwner
        ? deny('default_owner', "The business's default owner cannot be removed")
        : l.managers === 0
          ? lastManager
          : allow('members_manage', 'Removes a member')),
    summarize: () => 'Remove a member from the business',
    async run({ tx, loaded: { member } }) {
      await tx
        .delete(memberships)
        .where(and(eq(memberships.tenantId, member.tenantId), eq(memberships.userId, userId)));
      // Their access to single records goes with them.
      await tx
        .delete(recordGrants)
        .where(and(eq(recordGrants.tenantId, member.tenantId), eq(recordGrants.userId, userId)));
      return {
        value: { removed: true },
        touched: [
          { type: 'membership', id: userId, change: 'deleted', before: membershipJson(member) },
        ],
      };
    },
  });

/* ── Roles ────────────────────────────────────────────────────────────────── */

export const defineRole = () =>
  op({
    name: 'roles.define',
    resourceType: 'role',
    input: DefineRoleInput,
    resourceId: (input) => input.name,
    load: async (tx, p) => lockSettings(tx, tenantOf(p)),
    authorize(p, s, input) {
      const refused = manages(p);
      if (refused) return refused;
      if (declaredRoles.has(input.name) || s.roles.defined.some((r) => r.name === input.name))
        return deny('role_exists', `There is already a role called ${input.name}`);
      const problem = capabilityProblem(input.capabilities);
      if (problem) return deny('bad_capability', problem);
      return allow('members_manage', 'Defines a role for the business');
    },
    summarize: (input) => `Define the role ${input.name}`,
    async run({ tx, principal, input, loaded: s }) {
      const role = {
        name: input.name,
        label: input.label,
        capabilities: [...new Set(input.capabilities)],
      };
      const next = { ...s.roles, defined: [...s.roles.defined, role] };
      await saveRoles(tx, tenantOf(principal), s, next);
      const view = roleView(input.name, next) as RoleView;
      return {
        value: view,
        touched: [{ type: 'role', id: input.name, change: 'created', after: view }],
      };
    },
  });

export const editRole = (name: string) =>
  op({
    name: 'roles.edit',
    resourceType: 'role',
    input: EditRoleInput,
    args: { name },
    resourceId: () => name,
    async load(tx, p, input) {
      const tenantId = tenantOf(p);
      const s = await lockSettings(tx, tenantId);
      const before = roleView(name, s.roles);
      if (!before) throw notFound('role');
      const own = before.source === 'business';
      let next: RolesSettings;
      let problem: string | null = null;
      if (own) {
        if (input.label === null || input.capabilities === null)
          problem = "A business's own role needs a label and capabilities";
        next = {
          ...s.roles,
          defined: s.roles.defined.map((r) =>
            r.name === name
              ? {
                  ...r,
                  ...(input.label ? { label: input.label } : {}),
                  ...(input.capabilities ? { capabilities: [...new Set(input.capabilities)] } : {}),
                }
              : r,
          ),
        };
        problem ??= input.capabilities ? capabilityProblem(input.capabilities) : null;
      } else {
        const edit = { ...(s.roles.edits[name] ?? {}) };
        if (input.label === null) delete edit.label;
        else if (input.label) edit.label = input.label;
        if (input.capabilities === null) delete edit.capabilities;
        else if (input.capabilities) edit.capabilities = [...new Set(input.capabilities)];
        const edits = { ...s.roles.edits };
        if (edit.label || edit.capabilities) edits[name] = edit;
        else delete edits[name];
        next = { ...s.roles, edits };
        problem = input.capabilities
          ? capabilityProblem(input.capabilities, declaredCapabilities(name))
          : null;
      }
      return {
        s,
        before,
        next,
        problem,
        managers: managersAfter(await rolesByMember(tx, tenantId), next),
      };
    },
    authorize: (p, l) =>
      manages(p) ??
      (l.problem
        ? deny('bad_capability', l.problem)
        : l.managers === 0
          ? lastManager
          : allow('members_manage', 'Changes a role')),
    summarize: () => `Change the role ${name}`,
    async run({ tx, principal, loaded: { s, before, next } }) {
      await saveRoles(tx, tenantOf(principal), s, next);
      const after = roleView(name, next) as RoleView;
      return {
        value: after,
        touched: [{ type: 'role', id: name, change: 'updated', before, after }],
      };
    },
  });

export const removeRole = (name: string) =>
  op({
    name: 'roles.remove',
    resourceType: 'role',
    input: z.object({}).strict(),
    args: { name },
    resourceId: () => name,
    async load(tx, p) {
      const tenantId = tenantOf(p);
      const s = await lockSettings(tx, tenantId);
      const before = roleView(name, s.roles);
      if (!before) throw notFound('role');
      const own = before.source === 'business';
      const edits = { ...s.roles.edits };
      delete edits[name];
      const next: RolesSettings = own
        ? { ...s.roles, defined: s.roles.defined.filter((r) => r.name !== name) }
        : { ...s.roles, edits };
      const members = await rolesByMember(tx, tenantId);
      if (own)
        for (const [id, held] of members)
          members.set(
            id,
            held.filter((r) => r !== name),
          );
      return { s, before, own, next, managers: managersAfter(members, next) };
    },
    authorize: (p, l) =>
      manages(p) ??
      (!l.own && !l.before.edited
        ? deny('declared_role', 'This role comes with the application: change it, not delete it')
        : l.managers === 0
          ? lastManager
          : allow('members_manage', l.own ? 'Deletes a role' : 'Puts a role back as declared')),
    summarize: () => `Remove the role ${name}`,
    async run({ tx, principal, loaded: { s, before, own, next } }) {
      const tenantId = tenantOf(principal);
      await saveRoles(tx, tenantId, s, next);
      // Nobody keeps a role that is gone.
      if (own)
        await tx
          .update(memberships)
          .set({ roles: sql`array_remove(${memberships.roles}, ${name})` })
          .where(and(eq(memberships.tenantId, tenantId), sql`${name} = any(${memberships.roles})`));
      const after = own ? undefined : roleView(name, next);
      return {
        value: after ?? { removed: true },
        touched: [{ type: 'role', id: name, change: own ? 'deleted' : 'updated', before, after }],
      };
    },
  });

/* ── Invitations ──────────────────────────────────────────────────────────── */

type InviteRow = typeof memberInvites.$inferSelect;

export const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  email: r.email,
  roles: r.roles,
  invitedBy: r.invitedBy,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  acceptedAt: r.acceptedAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});

/** What is stored of a token: its SHA-256. */
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export const createInvite = () =>
  op({
    name: 'invites.create',
    resourceType: 'invite',
    input: CreateInviteInput,
    resourceId: () => null,
    load: async (tx, p) => lockSettings(tx, tenantOf(p)),
    authorize(p, s, input) {
      const refused = manages(p);
      if (refused) return refused;
      const unknown = unknownRoles(input.roles, s.roles);
      if (unknown.length)
        return deny('unknown_role', `This business has no role ${unknown.join(', ')}`);
      return allow('members_manage', 'Invites a person');
    },
    summarize: (input) => `Invite ${input.email}`,
    async run({ tx, principal, input, loaded: s }) {
      const token = randomBytes(32).toString('base64url');
      const days = s.members.inviteDays;
      const [row] = await tx
        .insert(memberInvites)
        .values({
          tenantId: tenantOf(principal),
          email: input.email,
          roles: [...new Set(input.roles)],
          tokenHash: tokenHash(token),
          invitedBy: principal.actor.id,
          expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        })
        .returning();
      const invite = toInvite(row);
      // The token is in the answer only: the audit row and the database keep its hash.
      return {
        value: { invite, token },
        touched: [{ type: 'invite', id: row.id, change: 'created', after: invite }],
      };
    },
  });

/** A pending invitation of this business, locked: 404 for anything else. */
async function pendingInvite(tx: Tx, where: ReturnType<typeof and>): Promise<InviteRow> {
  const [row] = await tx.select().from(memberInvites).where(where).for('update');
  if (!row || row.acceptedAt || row.revokedAt || row.expiresAt.getTime() <= Date.now())
    throw new NotFoundException({
      error: 'not_found',
      message: 'This invitation is not valid any more',
    });
  return row;
}

export const revokeInvite = (id: string) =>
  op({
    name: 'invites.revoke',
    resourceType: 'invite',
    input: z.object({}).strict(),
    args: { id },
    resourceId: () => id,
    load: (tx, p) =>
      pendingInvite(tx, and(eq(memberInvites.id, id), eq(memberInvites.tenantId, tenantOf(p)))),
    authorize: (p) => manages(p) ?? allow('members_manage', 'Takes back an invitation'),
    summarize: (_i, invite) => `Take back the invitation to ${invite.email}`,
    async run({ tx, loaded: invite }) {
      const [row] = await tx
        .update(memberInvites)
        .set({ revokedAt: new Date() })
        .where(eq(memberInvites.id, invite.id))
        .returning();
      const after = toInvite(row);
      return {
        value: after,
        touched: [{ type: 'invite', id, change: 'updated', before: toInvite(invite), after }],
      };
    },
  });

/**
 * Join a business with an invitation: p acts in the invitation's business (the controller makes
 * it so), with the roles the invitation gives added to any it holds there, and that business
 * becomes the person's default.
 */
export const acceptInvite = (inviteId: string) =>
  op({
    name: 'invites.accept',
    resourceType: 'invite',
    input: AcceptInviteInput,
    resourceId: () => inviteId,
    async load(tx, p, input) {
      const invite = await pendingInvite(
        tx,
        and(eq(memberInvites.id, inviteId), eq(memberInvites.tokenHash, tokenHash(input.token))),
      );
      const [member] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, invite.tenantId), eq(memberships.userId, p.actor.id)));
      return { invite, member };
    },
    authorize: () => allow('invite_accepted', 'Joins the business it was invited to'),
    summarize: (_i, { invite }) => `Join with the roles ${invite.roles.join(', ')}`,
    async run({ tx, principal, loaded: { invite, member } }) {
      const userId = principal.actor.id;
      const roles = [...new Set([...(member?.roles ?? []), ...invite.roles])];
      // One default business per person: this one now.
      await tx
        .update(memberships)
        .set({ isDefault: false })
        .where(and(eq(memberships.userId, userId), eq(memberships.isDefault, true)));
      const [after] = await tx
        .insert(memberships)
        .values({ tenantId: invite.tenantId, userId, roles, isDefault: true })
        .onConflictDoUpdate({
          target: [memberships.tenantId, memberships.userId],
          set: { roles, isDefault: true },
        })
        .returning();
      const [used] = await tx
        .update(memberInvites)
        .set({ acceptedAt: new Date(), acceptedBy: userId })
        .where(eq(memberInvites.id, invite.id))
        .returning();
      return {
        value: { tenantId: invite.tenantId, roles },
        touched: [
          {
            type: 'membership',
            id: userId,
            change: member ? 'updated' : 'created',
            before: member ? membershipJson(member) : undefined,
            after: membershipJson(after),
          },
          {
            type: 'invite',
            id: invite.id,
            change: 'updated',
            before: toInvite(invite),
            after: toInvite(used),
          },
        ],
      };
    },
  });

/* ── Record grants ────────────────────────────────────────────────────────── */

type GrantRow = typeof recordGrants.$inferSelect;

export const toGrant = (r: GrantRow): RecordGrant => ({
  id: r.id,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  userId: r.userId,
  grantedBy: r.grantedBy,
  createdAt: r.createdAt.toISOString(),
});

/** The record, if p reaches it: an entity this process serves, read through its scoped repo. */
export async function reachable(tx: Conn, p: Principal, resourceType: string, resourceId: string) {
  const def = entityDef(resourceType);
  const row = def ? await def.repo.find(tx, p, resourceId) : undefined;
  if (!row) throw notFound('record');
  return row;
}

const grants = (p: Principal) =>
  can(p, GRANT)
    ? null
    : deny('records_grant', 'Only people who give access to records can do this');

export const addGrant = () =>
  op({
    name: 'grants.add',
    resourceType: 'record_grant',
    input: AddGrantInput,
    resourceId: (input) => input.resourceId,
    async load(tx, p, input) {
      const tenantId = tenantOf(p);
      await reachable(tx, p, input.resourceType, input.resourceId);
      await memberOf(tx, tenantId, input.userId);
      return { tenantId };
    },
    authorize: (p) => grants(p) ?? allow('records_grant', 'Gives a member access to a record'),
    summarize: (input) => `Give a member access to this ${input.resourceType}`,
    async run({ tx, principal, input, loaded: { tenantId } }) {
      const values = { tenantId, ...input, grantedBy: principal.actor.id };
      const [created] = await tx
        .insert(recordGrants)
        .values(values)
        .onConflictDoNothing()
        .returning();
      const [row] = created
        ? [created]
        : await tx
            .select()
            .from(recordGrants)
            .where(
              and(
                eq(recordGrants.tenantId, tenantId),
                eq(recordGrants.resourceType, input.resourceType),
                eq(recordGrants.resourceId, input.resourceId),
                eq(recordGrants.userId, input.userId),
              ),
            );
      const grant = toGrant(row);
      return {
        value: grant,
        touched: created
          ? [{ type: 'record_grant', id: grant.id, change: 'created', after: grant }]
          : [],
      };
    },
  });

export const removeGrant = (id: string) =>
  op({
    name: 'grants.remove',
    resourceType: 'record_grant',
    input: z.object({}).strict(),
    args: { id },
    resourceId: () => id,
    async load(tx, p) {
      const [row] = await tx
        .select()
        .from(recordGrants)
        .where(and(eq(recordGrants.id, id), eq(recordGrants.tenantId, tenantOf(p))));
      if (!row) throw notFound('grant');
      await reachable(tx, p, row.resourceType, row.resourceId);
      return row;
    },
    authorize: (p) => grants(p) ?? allow('records_grant', 'Takes back access to a record'),
    summarize: (_i, row) => `Take back access to this ${row.resourceType}`,
    async run({ tx, loaded: row }) {
      await tx.delete(recordGrants).where(eq(recordGrants.id, row.id));
      return {
        value: { removed: true },
        touched: [{ type: 'record_grant', id: row.id, change: 'deleted', before: toGrant(row) }],
      };
    },
  });
