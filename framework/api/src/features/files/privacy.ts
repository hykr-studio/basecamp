import type { Subject } from '@hykr/contracts';
import { files } from '@hykr/db';
import { and, eq, ne, type SQL } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';

/** What a subject sent: a contact's files from their number, a person's uploads. */
const sentBy = (subject: Subject, tenantId?: string): SQL =>
  and(
    subject.kind === 'contact'
      ? eq(files.contactId, subject.contactId)
      : eq(files.ownerId, subject.userId),
    tenantId ? eq(files.tenantId, tenantId) : undefined,
    ne(files.status, 'erased'),
  ) as SQL;

/**
 * "Delete my data": every file the subject sent is erased in the erasure's transaction (its
 * name and words go now; nobody reaches it any more), and the sweeper deletes the objects
 * afterwards, so an erasure that rolls back deletes nothing. A record that held such a file
 * keeps its id; the file answers 404.
 */
export const filesErasure: ErasureContributor = {
  name: 'files',
  async erase({ subject, tenantId, tx }) {
    const erased = await tx
      .update(files)
      .set({
        status: 'erased',
        detachedAt: new Date(),
        name: 'erased',
        transcript: null,
        transcriptLang: null,
      })
      .where(sentBy(subject, tenantId))
      .returning({ id: files.id });
    return { count: erased.length };
  },
};

/** The subject's files, for their data export: what each is and the record it is on. */
export const filesExport: ExportContributor = {
  name: 'files',
  async export({ subject, tenantId, db }) {
    const rows = await db.select().from(files).where(sentBy(subject, tenantId));
    return {
      files: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        name: r.name,
        mime: r.mime,
        size: r.size,
        source: r.source,
        status: r.status,
        transcript: r.transcript,
        createdAt: r.createdAt.toISOString(),
        attachedTo: r.resourceType
          ? { entity: r.resourceType, id: r.resourceId, field: r.field }
          : null,
      })),
    };
  },
};
