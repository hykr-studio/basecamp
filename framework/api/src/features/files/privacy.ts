import type { Subject } from '@hykr/contracts';
import type { Tx } from '@hykr/core';
import { files } from '@hykr/db';
import { and, eq, inArray, ne, type SQL } from 'drizzle-orm';
import type { ErasedRecords, ErasureContributor, ExportContributor } from '../../hooks.js';
import { both, createdBy } from '../../privacy/contributors.js';

/**
 * Erased files, as a set whose copies lose the file's name and words: the `file.*` audit rows
 * (upload, confirm, attach, received) name the file as the person called it.
 */
export const fileCopies = (ids: readonly string[]): ErasedRecords => ({
  type: 'file',
  ids,
  fields: ['name', 'transcript'],
  deleted: true,
});

/** What a subject sent: a contact's files from their number, a person's uploads. */
const sentBy = (subject: Subject, tenantId?: string): SQL =>
  and(
    subject.kind === 'contact'
      ? eq(files.contactId, subject.contactId)
      : eq(files.ownerId, subject.userId),
    tenantId ? eq(files.tenantId, tenantId) : undefined,
    ne(files.status, 'erased'),
  ) as SQL;

/** The audit actions of a file someone sent: an upload, a file stored for them, one received. */
const SENT = ['file.upload', 'file.stored', 'file.received'] as const;

/**
 * "Delete my data": every file the subject sent is erased in the erasure's transaction (its
 * name and words go now; nobody reaches it any more), and the sweeper deletes the objects
 * afterwards, so an erasure that rolls back deletes nothing. A record that held such a file
 * keeps its id; the file answers 404. The files they sent that are gone already (an upload
 * thrown away, a file swept once taken off its record) lose their names in their audit rows
 * too: their own audit rows find them (decisions V8).
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
    const sent = await createdBy(tx, {
      type: 'file',
      ...(subject.kind === 'contact'
        ? { contactId: subject.contactId }
        : { userId: subject.userId }),
      tenantId,
      actions: SENT,
    });
    const ids = both(
      erased.map((f) => f.id),
      sent,
    );
    return { count: erased.length, erased: ids.length ? [fileCopies(ids)] : [] };
  },
};

/**
 * The files kept on these records go with them (a record erased or expired for personal data,
 * B18): erased now, deleted by the sweeper, so a rollback deletes nothing. `fields`: only the
 * files of these fields (an anonymised record keeps the rest). Returns the files' ids, whose
 * copies the caller redacts (`fileCopies`).
 */
export async function eraseFilesOn(
  tx: Tx,
  a: { tenantId: string; resourceType: string; ids: readonly string[]; fields?: readonly string[] },
): Promise<string[]> {
  if (!a.ids.length || a.fields?.length === 0) return [];
  const erased = await tx
    .update(files)
    .set({
      status: 'erased',
      detachedAt: new Date(),
      name: 'erased',
      transcript: null,
      transcriptLang: null,
    })
    .where(
      and(
        eq(files.tenantId, a.tenantId),
        eq(files.resourceType, a.resourceType),
        inArray(files.resourceId, [...a.ids]),
        a.fields ? inArray(files.field, [...a.fields]) : undefined,
        ne(files.status, 'erased'),
      ) as SQL,
    )
    .returning({ id: files.id });
  return erased.map((f) => f.id);
}

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
