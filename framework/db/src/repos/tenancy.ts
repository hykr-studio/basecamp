import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../database.js';
import { contacts } from '../schema/channel.js';
import { memberships, tenants } from '../schema/tenancy.js';

export type Membership = typeof memberships.$inferSelect;
export type Contact = typeof contacts.$inferSelect;

/**
 * The person's own business: a new sign-up owns one, so the template works for one person as
 * it always has. Safe to call twice (or from two places at once): the partial unique index on
 * the default membership makes the second a no-op.
 */
export async function ensureDefaultTenant(db: DbOrTx, userId: string, name: string) {
  const existing = await membershipOf(db, userId);
  if (existing) return existing;
  const [tenant] = await db
    .insert(tenants)
    .values({ name: name || 'My business', defaultOwnerId: userId })
    .returning();
  await db
    .insert(memberships)
    .values({ tenantId: tenant.id, userId, roles: ['owner'], isDefault: true })
    .onConflictDoNothing();
  const created = await membershipOf(db, userId);
  if (!created) throw new Error(`No business for user ${userId}`);
  return created;
}

/** The person's membership: in this tenant, or their default one. */
export async function membershipOf(
  db: DbOrTx,
  userId: string,
  tenantId?: string,
): Promise<Membership | undefined> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(
      tenantId
        ? and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId))
        : eq(memberships.userId, userId),
    )
    .orderBy(desc(memberships.isDefault))
    .limit(1);
  return row;
}

export async function contactById(db: DbOrTx, id: string): Promise<Contact | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  return row;
}

/** Who owns records in a business that nobody on its staff made. */
export async function defaultOwnerOf(db: DbOrTx, tenantId: string): Promise<string> {
  const [row] = await db
    .select({ id: tenants.defaultOwnerId })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new Error(`No such business ${tenantId}`);
  return row.id;
}
