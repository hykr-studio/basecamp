// A business's invitations name the person by email (decisions V3): they go when the person is
// erased from the business, are in their copy of their data, and are on the register. Nothing
// here loads Nest.
import type { Conn } from '@hykr/core';
import { memberInvites, user } from '@hykr/db';
import { and, eq, or, type SQL } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';
import { definePersonalDataPart } from '../privacy/registry.js';

/** The account's email, lower case, as invitations store it. */
export async function emailOf(conn: Conn, userId: string): Promise<string | null> {
  const [u] = await conn.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return u?.email.trim().toLowerCase() || null;
}

/** Invitations of this business (or every one) sent to the person's email, or accepted by them. */
const invitesOf = (userId: string, email: string | null, tenantId?: string): SQL =>
  and(
    tenantId ? eq(memberInvites.tenantId, tenantId) : undefined,
    or(eq(memberInvites.acceptedBy, userId), email ? eq(memberInvites.email, email) : undefined),
  ) as SQL;

/**
 * The person's invitations are deleted, pending, accepted or taken back alike: their audit rows
 * lose the email (an `invite` set). Runs with the other contributors, before the account's email
 * is replaced.
 */
export const invitesErasure: ErasureContributor = {
  name: 'invites',
  async erase({ subject, tenantId, tx }) {
    if (subject.kind !== 'user') return { count: 0 };
    const gone = await tx
      .delete(memberInvites)
      .where(invitesOf(subject.userId, await emailOf(tx, subject.userId), tenantId))
      .returning({ id: memberInvites.id });
    const ids = gone.map((i) => i.id);
    return {
      count: ids.length,
      erased: ids.length ? [{ type: 'invite', ids, fields: ['email'], deleted: true }] : [],
    };
  },
};

/** The invitations sent to the person, for their copy: never the token's hash. */
export const invitesExport: ExportContributor = {
  name: 'invites',
  async export({ subject, tenantId, db }): Promise<Record<string, readonly unknown[]>> {
    if (subject.kind !== 'user') return {};
    const rows = await db
      .select()
      .from(memberInvites)
      .where(invitesOf(subject.userId, await emailOf(db, subject.userId), tenantId));
    return {
      invites: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        email: r.email,
        roles: r.roles,
        createdAt: r.createdAt.toISOString(),
        acceptedAt: r.acceptedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
      })),
    };
  },
};

export const membersParts = [
  definePersonalDataPart({
    name: 'members.invites',
    label: {
      en: 'Invitations to join the business',
      hi: 'व्यवसाय से जुड़ने के निमंत्रण',
      te: 'వ్యాపారంలో చేరడానికి ఆహ్వానాలు',
    },
    fields: ['email'],
    erase: 'delete',
  }),
];
