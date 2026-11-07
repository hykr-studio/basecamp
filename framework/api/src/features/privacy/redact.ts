// Audit redaction (B18): the server keeps copies of records (audit rows' before and after, stored
// events, approvals' inputs and cards, notifications' rows, messages' notification rows). When a
// record is erased or blanked for personal data, its personal fields leave every copy; the rows
// stay, with their ids, so the trail of who did what stays whole. Derived data goes too: the
// record's files, and its memory vectors. Nothing here loads Nest.

import { fileFieldsOf } from '@hykr/contracts';
import type { Tx } from '@hykr/core';
import { entityDef } from '@hykr/core';
import { type SQL, sql } from 'drizzle-orm';
import { eraseFilesOn } from '../files/privacy.js';
import { forgetRecords } from '../memory/privacy.js';
import type { ErasedRecords } from './registry.js';

const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );
const keys = (xs: readonly string[]) => sql`ARRAY[${list(xs)}]::text[]`;

/** A jsonb object without these keys; anything else as it is. */
const without = (col: SQL, ks: SQL) =>
  sql`case when jsonb_typeof(${col}) = 'object' then ${col} - ${ks} else ${col} end`;

/** How many copies lost something, by where they are. */
export interface Redacted {
  audit: number;
  events: number;
  approvals: number;
  notifications: number;
  messages: number;
  files: number;
  memory: number;
}

const rowsOf = (r: unknown) => (r as { rowCount?: number | null }).rowCount ?? 0;

/**
 * Take the personal fields of these records out of every copy the server keeps of them, in this
 * business, and erase what is derived from them. `deleted`: the records are gone, so all their
 * files go; otherwise only the files of their personal fields.
 */
export async function redactCopies(
  tx: Tx,
  tenantId: string,
  sets: readonly ErasedRecords[],
): Promise<Redacted> {
  const out: Redacted = {
    audit: 0,
    events: 0,
    approvals: 0,
    notifications: 0,
    messages: 0,
    files: 0,
    memory: 0,
  };
  for (const set of sets) {
    if (!set.ids.length) continue;
    const ids = list(set.ids);
    const fields = keys(set.fields);
    // An approval card's or a park's summary names the record ('Delete "Call Ravi"').
    const withSummary = keys([...set.fields, 'summary']);
    out.audit += rowsOf(
      await tx.execute(sql`
        update audit.events
        set before = ${without(sql`before`, fields)}, after = ${without(sql`after`, withSummary)}
        where tenant_id = ${tenantId} and resource_type = ${set.type} and resource_id in (${ids})
          and (before is not null or after is not null)`),
    );
    out.events += rowsOf(
      await tx.execute(sql`
        update app.domain_events
        set "row" = ${without(sql`"row"`, fields)}, before = ${without(sql`before`, fields)}
        where tenant_id = ${tenantId} and resource_type = ${set.type} and resource_id in (${ids})`),
    );
    out.approvals += rowsOf(
      await tx.execute(sql`
        update app.approvals
        set summary = null,
            payload = case when jsonb_typeof(payload -> 'input') = 'object'
              then jsonb_set(payload, '{input}', (payload -> 'input') - ${fields})
              else payload end
        where tenant_id = ${tenantId} and resource_type = ${set.type} and resource_id in (${ids})`),
    );
    out.notifications += rowsOf(
      await tx.execute(sql`
        update app.outbox
        set payload = jsonb_set(payload, '{row}', (payload -> 'row') - ${fields})
        where tenant_id = ${tenantId} and jsonb_typeof(payload -> 'row') = 'object'
          and payload -> 'row' ->> 'id' in (${ids})`),
    );
    out.messages += rowsOf(
      await tx.execute(sql`
        update channel.messages
        set meta = jsonb_set(meta, '{row}', (meta -> 'row') - ${fields})
        where tenant_id = ${tenantId} and jsonb_typeof(meta -> 'row') = 'object'
          and meta -> 'row' ->> 'id' in (${ids})`),
    );
    const def = entityDef(set.type);
    const fileFields = fileFieldsOf(def?.spec)
      .map(([f]) => f)
      .filter((f) => set.fields.includes(f));
    out.files += await eraseFilesOn(tx, {
      tenantId,
      resourceType: set.type,
      ids: set.ids,
      ...(set.deleted ? {} : { fields: fileFields }),
    });
    out.memory += await forgetRecords(tx, { tenantId, resourceType: set.type, ids: set.ids });
  }
  return out;
}
