import { documents } from '@hykr/db';
import { and, eq } from 'drizzle-orm';
import type { ExportContributor } from '../../hooks.js';

/**
 * The documents a person (or a contact) asked for, for their data export: which, about which
 * record, when, and its state. Not the data it shows: that is the business's record. Documents
 * are not erased with the person: they are the business's, kept with their record.
 */
export const documentsExport: ExportContributor = {
  name: 'documents',
  async export({ subject, tenantId, db }) {
    const rows = await db
      .select()
      .from(documents)
      .where(
        and(
          subject.kind === 'user'
            ? eq(documents.requestedBy, subject.userId)
            : eq(documents.requestedByContact, subject.contactId),
          tenantId ? eq(documents.tenantId, tenantId) : undefined,
        ),
      );
    return {
      documents: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        document: r.name,
        record: { entity: r.resourceType, id: r.resourceId },
        version: r.version,
        lang: r.lang,
        status: r.status,
        name: r.fileName,
        sha256: r.sha256,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
};
