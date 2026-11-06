import {
  acceptsMime,
  type FileFieldPolicy,
  fileFieldsOf,
  fileIdsIn,
  type Principal,
} from '@hykr/contracts';
import {
  auditCtx,
  deny,
  entityDef,
  RuleDenied,
  type Tx,
  type WriteCtx,
  type WriteHook,
} from '@hykr/core';
import { files, writeAudit } from '@hykr/db';
import { and, eq, inArray } from 'drizzle-orm';
import { filesConfig } from './config.js';
import { maxBytesOf, maxFilesOf } from './fields.js';
import { type FileRow, uploadedBy } from './files.service.js';

type Values = Record<string, unknown>;

/** One answer for a missing, foreign, pending, taken or unfit file: it says nothing more. */
const unavailable = () =>
  new RuleDenied(
    deny(
      'file_unavailable',
      'A file is missing, not yours to use, already on another record, or not accepted by this field',
    ),
  );

/** A record's field: the files it holds now. */
interface Slot {
  type: string;
  id: string;
  field: string;
  policy: FileFieldPolicy;
}

/** The ready files on this record's field. */
async function heldBy(tx: Tx, tenantId: string, slot: Omit<Slot, 'policy'>): Promise<string[]> {
  const rows = await tx
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.tenantId, tenantId),
        eq(files.resourceType, slot.type),
        eq(files.resourceId, slot.id),
        eq(files.field, slot.field),
        eq(files.status, 'ready'),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Can p put this file on this record's field? A ready file of this business, not on any record
 * yet and uploaded by the same subject, or one this very field let go of (put back before it is
 * swept); of a type and size the field takes.
 */
function fits(row: FileRow | undefined, p: Principal, slot: Partial<Slot> & Pick<Slot, 'policy'>) {
  if (!row || row.tenantId !== p.tenantId) return false;
  const free = row.status === 'ready' && !row.resourceId && uploadedBy(row, p);
  const back =
    row.status === 'detached' &&
    slot.id !== undefined &&
    row.resourceType === slot.type &&
    row.resourceId === slot.id &&
    row.field === slot.field;
  if (!free && !back) return false;
  return (
    acceptsMime(slot.policy, row.mime) &&
    row.size <= maxBytesOf(slot.policy, filesConfig().maxBytes)
  );
}

/** Lock and check the files a write adds to one field; every one must fit, or none is taken. */
async function check(
  tx: Tx,
  p: Principal,
  slot: Partial<Slot> & Pick<Slot, 'policy'>,
  ids: readonly string[],
): Promise<FileRow[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select()
    .from(files)
    .where(and(inArray(files.id, [...ids]), eq(files.tenantId, p.tenantId ?? '')))
    .for('update');
  for (const id of ids)
    if (
      !fits(
        rows.find((r) => r.id === id),
        p,
        slot,
      )
    )
      throw unavailable();
  return rows;
}

/**
 * The field's files become exactly `wanted`: new ones are claimed, missing ones let go. An id the
 * record already had (`prior`, from the row before the write) is not new even when its file is
 * gone (erased, swept): a client that sends the list back unchanged is not refused for it.
 */
async function sync(tx: Tx, ctx: WriteCtx, slot: Slot, wanted: string[], prior: string[]) {
  const p = ctx.principal;
  if (wanted.length > maxFilesOf(slot.policy)) throw unavailable();
  const held = await heldBy(tx, p.tenantId ?? '', slot);
  const added = wanted.filter((id) => !held.includes(id) && !prior.includes(id));
  const removed = held.filter((id) => !wanted.includes(id));
  const audit = (action: string, row: { id: string; name: string }) =>
    writeAudit(tx, {
      ...auditCtx(p, { rule: 'files', reason: action }, ctx),
      action,
      resourceType: 'file',
      resourceId: row.id,
      after: { name: row.name, on: { entity: slot.type, id: slot.id, field: slot.field } },
    });
  for (const row of await check(tx, p, slot, added)) {
    await tx
      .update(files)
      .set({
        status: 'ready',
        resourceType: slot.type,
        resourceId: slot.id,
        field: slot.field,
        attachedAt: new Date(),
        detachedAt: null,
      })
      .where(eq(files.id, row.id));
    await audit('file.attach', row);
  }
  if (removed.length) {
    const gone = await tx
      .update(files)
      .set({ status: 'detached', detachedAt: new Date() })
      .where(and(inArray(files.id, removed), eq(files.status, 'ready')))
      .returning();
    for (const row of gone) await audit('file.detach', row);
  }
}

/** A deleted record lets go of every file it held. */
async function releaseAll(tx: Tx, ctx: WriteCtx, type: string, id: string) {
  const p = ctx.principal;
  const gone = await tx
    .update(files)
    .set({ status: 'detached', detachedAt: new Date() })
    .where(
      and(
        eq(files.tenantId, p.tenantId ?? ''),
        eq(files.resourceType, type),
        eq(files.resourceId, id),
        eq(files.status, 'ready'),
      ),
    )
    .returning();
  for (const row of gone)
    await writeAudit(tx, {
      ...auditCtx(p, { rule: 'files', reason: 'file.detach' }, ctx),
      action: 'file.detach',
      resourceType: 'file',
      resourceId: row.id,
      after: { name: row.name, on: { entity: type, id, field: row.field } },
    });
}

/**
 * Attaching is the record's own write. After a write runs (in its transaction), each touched
 * record of an entity with file fields has its fields' files made to match the row: new ids are
 * claimed (each must be the writer's own upload, or one the field let go of, and fit the field),
 * ids that left a field are let go, and a deleted record lets go of all. A write that parks has
 * its new ids checked now (nothing is claimed until the approved write runs), so an approval
 * never carries a file its requester could not use. Any file that does not fit refuses the whole
 * write (`file_unavailable`, rolled back and audited as denied).
 */
export const filesWriteHook: WriteHook = {
  name: 'files',
  async afterRun({ ctx, op, input, loaded, tx, touched, result }) {
    const p = ctx.principal;
    if (result.status === 'needs_approval') {
      if (op.kind !== 'entity') return;
      const def = entityDef(op.resourceType);
      if (!def) return;
      const recordId = (loaded as { id?: string } | null)?.id;
      for (const [field, policy] of fileFieldsOf(def.spec)) {
        const value = (input as Values | null)?.[field];
        if (value === undefined) continue;
        const wanted = [...new Set(fileIdsIn(value))];
        if (wanted.length > maxFilesOf(policy)) throw unavailable();
        const held = recordId
          ? await heldBy(tx, p.tenantId ?? '', { type: def.name, id: recordId, field })
          : [];
        const prior = fileIdsIn((loaded as Values | null)?.[field]);
        const slot = { type: def.name, id: recordId, field, policy };
        await check(
          tx,
          p,
          slot,
          wanted.filter((id) => !held.includes(id) && !prior.includes(id)),
        );
      }
      return;
    }
    for (const t of touched) {
      const def = entityDef(t.type);
      const fields = def ? fileFieldsOf(def.spec) : [];
      if (!def || !fields.length) continue;
      if (t.change === 'deleted') {
        await releaseAll(tx, ctx, def.name, t.id);
        continue;
      }
      const after = t.after as Values | undefined;
      if (!after) continue;
      const before = t.before as Values | undefined;
      for (const [field, policy] of fields) {
        if (!(field in after)) continue;
        await sync(
          tx,
          ctx,
          { type: def.name, id: t.id, field, policy },
          [...new Set(fileIdsIn(after[field]))],
          fileIdsIn(before?.[field]),
        );
      }
    }
  },
};
