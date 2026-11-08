// Audit redaction (B18): the server keeps copies of records (audit rows' before and after, stored
// events, approvals' inputs and cards, notifications' rows, messages' notification rows, the
// replies kept for idempotent retries, and each feature's own: `recordCopies`). When a record is
// erased or blanked for personal data, its personal fields leave every copy; the rows stay, with
// their ids, so the trail of who did what stays whole. Derived data goes too: the record's
// files, and its memory vectors. A privacy filing about the person loses the email or number it
// named them by, and its note. Nothing here loads Nest.

import { FilePrivacyRequestSpec, fileFieldsOf } from '@hykr/contracts';
import type { Tx } from '@hykr/core';
import { entityDef } from '@hykr/core';
import { approvals, events as auditEvents, idempotencyKeys } from '@hykr/db';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { ErasedRecords } from '../../hooks.js';
import { eraseFilesOn } from '../files/privacy.js';
import { forgetRecords } from '../memory/privacy.js';
import { recordCopies } from './registry.js';

const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );
const keys = (xs: readonly string[]) => sql`ARRAY[${list(xs)}]::text[]`;

/** A jsonb object without these keys; anything else as it is. */
const without = (col: SQL, ks: SQL) =>
  sql`case when jsonb_typeof(${col}) = 'object' then ${col} - ${ks} else ${col} end`;

/** How many copies lost something, by where they are (and each feature's own, `recordCopies`). */
export interface Redacted {
  audit: number;
  events: number;
  approvals: number;
  notifications: number;
  messages: number;
  files: number;
  memory: number;
  /** Replies kept for idempotent retries. */
  replies: number;
  [where: string]: number;
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
    replies: 0,
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
    // The reply kept for a retry: the record as it was written. Its key names the business
    // (`<actor kind>:<actor id>:<tenant>:<subject>`).
    out.replies += rowsOf(
      await tx.execute(sql`
        update app.idempotency
        set response = jsonb_set(response, '{value}', (response -> 'value') - ${fields})
        where split_part(principal_id, ':', 3) = ${tenantId}
          and jsonb_typeof(response -> 'value') = 'object'
          and response -> 'value' ->> 'id' in (${ids})`),
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
    // Each feature's own copies (webhook bodies, payloads).
    for (const copies of recordCopies.all())
      for (const [where, n] of Object.entries(await copies.redact({ tx, tenantId, set })))
        out[where] = (out[where] ?? 0) + n;
  }
  return out;
}

/* ── Privacy filings about the person ─────────────────────────────────────── */

/** Whom a privacy filing may name: a person's account and emails, their contacts and numbers. */
export interface FiledAbout {
  userId: string | null;
  /** The account's emails, lower case. */
  emails: readonly string[];
  /** Their contacts here, with their numbers (digits only). */
  contacts: readonly { id: string; address: string }[];
  /** Their requests' ids: replies that carry a request lose its note. */
  requestIds: readonly string[];
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * A privacy filing's input (`privacy.request`) without the person's email or number and without
 * its note, when it is about them: its `for` names them, or they filed it for themselves (`filer`).
 * The email or number becomes the id it named, so the trail still says whom it was for and a
 * replay finds the same person (gone). Null: it is not about them, or holds nothing to take out.
 */
export function scrubFiling(
  input: unknown,
  about: FiledAbout,
  filer: { userId?: unknown; contactId?: unknown } = {},
): Obj | null {
  if (!isObj(input)) return null;
  const who = input.for;
  let named = false;
  let byId: Obj | undefined;
  if (isObj(who)) {
    if (typeof who.userId === 'string') named = !!about.userId && who.userId === about.userId;
    else if (typeof who.contactId === 'string')
      named = about.contacts.some((c) => c.id === who.contactId);
    else if (typeof who.email === 'string') {
      named = !!about.userId && about.emails.includes(who.email.trim().toLowerCase());
      if (named) byId = { userId: about.userId };
    } else if (typeof who.address === 'string') {
      const address = who.address.replace(/^\+/, '');
      const c = about.contacts.find((x) => x.address === address);
      named = !!c;
      if (c) byId = { contactId: c.id };
    }
  } else if (who === undefined) {
    named =
      (!!about.userId && filer.userId === about.userId) ||
      about.contacts.some((c) => c.id === filer.contactId);
  }
  if (!named || (!byId && !Object.hasOwn(input, 'note'))) return null;
  const { note: _note, ...rest } = input;
  return byId ? { ...rest, for: byId } : rest;
}

/** An approval row (as stored, or as an audit row's before or after) with its filing scrubbed. */
function scrubApprovalCopy(copy: unknown, about: FiledAbout): Obj | null {
  if (!isObj(copy) || copy.action !== FilePrivacyRequestSpec.name) return null;
  const filer = { userId: copy.ownerId, contactId: copy.requesterContactId };
  let out: Obj | null = null;
  const payload = copy.payload;
  if (isObj(payload)) {
    const input = scrubFiling(payload.input, about, filer);
    if (input) out = { ...copy, payload: { ...payload, input } };
  }
  // An approval as clients read it carries its input on top.
  const top = scrubFiling(copy.input, about, filer);
  if (top) out = { ...(out ?? copy), input: top };
  return out;
}

/** Who an idempotency key was for: `<actor kind>:<actor id>:<tenant>:<subject kind>:<id>`. */
function filerOfKey(principalId: string): { userId?: string; contactId?: string } {
  const [, , , kind, id] = principalId.split(':');
  if (kind === 'user') return { userId: id };
  if (kind === 'contact') return { contactId: id };
  return {};
}

/**
 * Take the person's email, number and the notes out of the privacy filings about them, in this
 * business: the approvals that held a filing (and replay it), their audit rows' before and
 * after, and the replies kept for retries (with the requests' own notes). Returns how many
 * rows changed, by where they are.
 */
export async function redactFilings(
  tx: Tx,
  tenantId: string,
  about: FiledAbout,
): Promise<{ approvals: number; audit: number; replies: number }> {
  const out = { approvals: 0, audit: 0, replies: 0 };
  const filings = await tx
    .select({
      id: approvals.id,
      payload: approvals.payload,
      ownerId: approvals.ownerId,
      requesterContactId: approvals.requesterContactId,
    })
    .from(approvals)
    .where(
      and(eq(approvals.tenantId, tenantId), eq(approvals.action, FilePrivacyRequestSpec.name)),
    );
  for (const row of filings) {
    const scrubbed = scrubApprovalCopy({ ...row, action: FilePrivacyRequestSpec.name }, about);
    if (!scrubbed) continue;
    await tx.update(approvals).set({ payload: scrubbed.payload }).where(eq(approvals.id, row.id));
    out.approvals++;
  }

  const action = FilePrivacyRequestSpec.name;
  const trail = await tx
    .select({ id: auditEvents.id, before: auditEvents.before, after: auditEvents.after })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.resourceType, 'approval'),
        or(
          sql`${auditEvents.before} ->> 'action' = ${action}`,
          sql`${auditEvents.after} ->> 'action' = ${action}`,
        ),
      ),
    );
  for (const row of trail) {
    const before = scrubApprovalCopy(row.before, about);
    const after = scrubApprovalCopy(row.after, about);
    if (!before && !after) continue;
    await tx
      .update(auditEvents)
      .set({ ...(before ? { before } : {}), ...(after ? { after } : {}) })
      .where(eq(auditEvents.id, row.id));
    out.audit++;
  }

  const requests = about.requestIds.length
    ? sql`response -> 'value' ->> 'id' in (${sql.join(
        about.requestIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`false`;
  const replies = await tx
    .select({
      key: idempotencyKeys.key,
      principalId: idempotencyKeys.principalId,
      response: idempotencyKeys.response,
    })
    .from(idempotencyKeys)
    .where(
      and(
        sql`split_part(${idempotencyKeys.principalId}, ':', 3) = ${tenantId}`,
        or(sql`${idempotencyKeys.response} -> 'approval' ->> 'action' = ${action}`, requests),
      ),
    );
  for (const row of replies) {
    if (!isObj(row.response)) continue;
    let response: Obj | null = null;
    const approval = row.response.approval;
    if (isObj(approval) && approval.action === action) {
      const input = scrubFiling(approval.input, about, filerOfKey(row.principalId));
      if (input) response = { ...row.response, approval: { ...approval, input } };
    }
    const value = row.response.value;
    if (
      isObj(value) &&
      typeof value.id === 'string' &&
      about.requestIds.includes(value.id) &&
      Object.hasOwn(value, 'note')
    ) {
      const { note: _note, ...rest } = value;
      response = { ...(response ?? row.response), value: rest };
    }
    if (!response) continue;
    await tx
      .update(idempotencyKeys)
      .set({ response })
      .where(
        and(eq(idempotencyKeys.key, row.key), eq(idempotencyKeys.principalId, row.principalId)),
      );
    out.replies++;
  }
  return out;
}
