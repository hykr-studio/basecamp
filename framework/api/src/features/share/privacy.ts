import type { Subject } from '@hykr/contracts';
import type { Conn } from '@hykr/core';
import { shareLinks } from '@hykr/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';
import { emailOf } from '../members/privacy.js';
import { targetOf } from './ops.js';

/**
 * The links made for the subject: a contact's, or those sent to a person's email (a link names
 * an email, never an account). None when a person has no email.
 */
async function naming(conn: Conn, subject: Subject, tenantId?: string): Promise<SQL | undefined> {
  const email = subject.kind === 'user' ? await emailOf(conn, subject.userId) : null;
  if (subject.kind === 'user' && !email) return undefined;
  return and(
    subject.kind === 'contact'
      ? eq(shareLinks.contactId, subject.contactId)
      : sql`lower(${shareLinks.email}) = ${email}`,
    tenantId ? eq(shareLinks.tenantId, tenantId) : undefined,
  ) as SQL;
}

/**
 * "Delete my data": every link made for the subject is revoked and forgets whom it was for
 * (the contact or email, where its code went, and its label, which the maker wrote for them), in
 * the erasure's transaction. The rows stay (the audit names them), without the person; their
 * copies (audit rows, replies) lose the same.
 */
export const shareLinksErasure: ErasureContributor = {
  name: 'share-links',
  async erase({ subject, tenantId, tx }) {
    const where = await naming(tx, subject, tenantId);
    if (!where) return { count: 0 };
    const erased = await tx
      .update(shareLinks)
      .set({
        revokedAt: new Date(),
        revokedBy: 'erasure',
        contactId: null,
        email: null,
        otpChannel: null,
        otpAddress: null,
        label: null,
      })
      .where(where)
      .returning({ id: shareLinks.id });
    return {
      count: erased.length,
      erased: [
        {
          type: 'shareLink',
          ids: erased.map((l) => l.id),
          fields: ['to', 'otp', 'label', 'email', 'otpAddress'],
        },
      ],
    };
  },
};

/** The links made for a contact, for their data export: what each opened and when. */
export const shareLinksExport: ExportContributor = {
  name: 'share-links',
  async export({ subject, tenantId, db }) {
    const where = await naming(db, subject, tenantId);
    if (!where) return { shareLinks: [] };
    const rows = await db.select().from(shareLinks).where(where);
    return {
      shareLinks: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        kind: r.kind,
        target: targetOf(r),
        label: r.label,
        views: r.views,
        expiresAt: r.expiresAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
};
