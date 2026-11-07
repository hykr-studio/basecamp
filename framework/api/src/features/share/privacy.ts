import type { Subject } from '@hykr/contracts';
import { shareLinks } from '@hykr/db';
import { and, eq, type SQL } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';
import { targetOf } from './ops.js';

/** The links a contact is the recipient of (a person's account is never one). */
const naming = (subject: Subject, tenantId?: string): SQL | undefined =>
  subject.kind === 'contact'
    ? (and(
        eq(shareLinks.contactId, subject.contactId),
        tenantId ? eq(shareLinks.tenantId, tenantId) : undefined,
      ) as SQL)
    : undefined;

/**
 * "Delete my data" for a contact: every link made for them is revoked and forgets where its code
 * went, in the erasure's transaction. The rows stay (the audit names them), without the contact.
 */
export const shareLinksErasure: ErasureContributor = {
  name: 'share-links',
  async erase({ subject, tenantId, tx }) {
    const where = naming(subject, tenantId);
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
      })
      .where(where)
      .returning({ id: shareLinks.id });
    return { count: erased.length };
  },
};

/** The links made for a contact, for their data export: what each opened and when. */
export const shareLinksExport: ExportContributor = {
  name: 'share-links',
  async export({ subject, tenantId, db }) {
    const where = naming(subject, tenantId);
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
