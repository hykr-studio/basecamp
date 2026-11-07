// Businesses, as operators manage them (B19): list them, make one for a person who has an account
// (they become its owner, with the creator's roles), rename one. Each write is the operator's
// system job in that business, audited there on behalf of the operator.
import { randomUUID } from 'node:crypto';
import {
  givenRoles,
  type PlatformTenant,
  ProvisionTenantInput,
  RenameTenantInput,
} from '@hykr/contracts';
import { allow, type WriteOp } from '@hykr/core';
import { type DbOrTx, memberships, tenants, user } from '@hykr/db';
import { NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, gt, ilike, sql } from 'drizzle-orm';

/** A business was made by an operator: a subscriber may set it up (its own defaults, data). */
export class TenantProvisioned {
  readonly eventName = 'tenant.provisioned';
  readonly resourceType = 'tenant';
  constructor(readonly row: { id: string; name: string; ownerId: string; operatorId: string }) {}
}

const noBusiness = () => new NotFoundException({ error: 'not_found', message: 'No such business' });

/** Businesses by id, with their member counts. */
export async function listTenants(
  db: DbOrTx,
  q: { q?: string; after?: string; limit?: number; id?: string } = {},
): Promise<{ items: PlatformTenant[]; next: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const members = db
    .select({ tenantId: memberships.tenantId, n: count().as('n') })
    .from(memberships)
    .groupBy(memberships.tenantId)
    .as('members');
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      defaultOwnerId: tenants.defaultOwnerId,
      createdAt: tenants.createdAt,
      members: sql<number>`coalesce(${members.n}, 0)`,
    })
    .from(tenants)
    .leftJoin(members, eq(members.tenantId, tenants.id))
    .where(
      and(
        q.id ? eq(tenants.id, q.id) : undefined,
        q.q ? ilike(tenants.name, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
        q.after ? gt(tenants.id, q.after) : undefined,
      ),
    )
    .orderBy(asc(tenants.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    defaultOwnerId: r.defaultOwnerId,
    members: Number(r.members),
    createdAt: r.createdAt.toISOString(),
  }));
  return { items, next: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

export async function oneTenant(db: DbOrTx, id: string): Promise<PlatformTenant> {
  const { items } = await listTenants(db, { id, limit: 1 });
  const [tenant] = items;
  if (!tenant) throw noBusiness();
  return tenant;
}

/** A new business's id, chosen before its write so the write is audited in it. */
export const newTenantId = () => randomUUID();

type Owner = { id: string; hasDefault: boolean };

/**
 * Make a business for a person who has an account: they own it (its default owner, a membership
 * with the creator's roles), and it becomes their default business only if they have none.
 */
export const provisionTenant = (
  tenantId: string,
  operatorId: string,
): WriteOp<ProvisionTenantInput, Owner, PlatformTenant> => ({
  name: 'tenant.provision',
  kind: 'command',
  resourceType: 'tenant',
  input: ProvisionTenantInput,
  resourceId: () => tenantId,
  system: true,
  async load(tx, _p, input) {
    const email = input.owner.email.toLowerCase();
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${email}`)
      .limit(2);
    if (found.length !== 1)
      throw new NotFoundException({
        error: 'no_account',
        reason: 'Nobody has an account with this email: ask them to sign up first',
      });
    const [owner] = found;
    const [mine] = await tx
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.userId, owner.id), eq(memberships.isDefault, true)));
    return { id: owner.id, hasDefault: Number(mine?.n ?? 0) > 0 };
  },
  authorize: () => allow('operator_provisions', 'An operator makes a business'),
  summarize: (input) => `Make the business ${input.name}`,
  async run({ tx, input, loaded: owner }) {
    const [tenant] = await tx
      .insert(tenants)
      .values({ id: tenantId, name: input.name, defaultOwnerId: owner.id })
      .returning();
    const roles = givenRoles('creator');
    await tx
      .insert(memberships)
      .values({ tenantId, userId: owner.id, roles, isDefault: !owner.hasDefault });
    const value = await oneTenant(tx, tenant.id);
    return {
      value,
      touched: [
        { type: 'tenant', id: tenantId, change: 'created', after: value },
        {
          type: 'membership',
          id: owner.id,
          change: 'created',
          after: { tenantId, userId: owner.id, roles, isDefault: !owner.hasDefault },
        },
      ],
      events: [
        new TenantProvisioned({ id: tenantId, name: input.name, ownerId: owner.id, operatorId }),
      ],
    };
  },
  present: (value) => value,
});

/** Rename a business. */
export const renameTenant = (
  tenantId: string,
): WriteOp<RenameTenantInput, { name: string }, PlatformTenant> => ({
  name: 'tenant.rename',
  kind: 'command',
  resourceType: 'tenant',
  input: RenameTenantInput,
  args: { tenantId },
  resourceId: () => tenantId,
  system: true,
  async load(tx) {
    const [row] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for('update');
    if (!row) throw noBusiness();
    return row;
  },
  authorize: () => allow('operator_renames', 'An operator renames a business'),
  summarize: (input) => `Rename the business to ${input.name}`,
  async run({ tx, input, loaded }) {
    await tx.update(tenants).set({ name: input.name }).where(eq(tenants.id, tenantId));
    const value = await oneTenant(tx, tenantId);
    return {
      value,
      touched: [
        {
          type: 'tenant',
          id: tenantId,
          change: 'updated',
          before: { name: loaded.name },
          after: { name: input.name },
        },
      ],
    };
  },
  present: (value) => value,
});
