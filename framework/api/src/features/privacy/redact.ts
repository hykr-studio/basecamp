// Audit redaction (B18): the server keeps copies of records (audit rows' before and after, stored
// events, approvals' inputs and cards, notifications' rows, messages' notification rows, the
// replies kept for idempotent retries, and each feature's own: `recordCopies`). When a record is
// erased or blanked for personal data, its personal fields leave every copy, at any depth (a
// reply's nested record, an order's lines, a command's input that names it); the rows stay,
// with their ids, so the trail of who did what stays whole. Derived data goes too: the record's
// files (and their names in the files' own audit rows), and its memory vectors. A privacy filing
// about the person loses the email or number it named them by, and its note. Nothing here loads
// Nest. docs/decisions/B18.md and V3.md.

import { FilePrivacyRequestSpec, fileFieldsOf } from '@hykr/contracts';
import type { Tx } from '@hykr/core';
import { entityDef } from '@hykr/core';
import { approvals, events as auditEvents, idempotencyKeys } from '@hykr/db';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { ErasedRecords } from '../../hooks.js';
import { eraseFilesOn, fileCopies } from '../files/privacy.js';
import { forgetRecords } from '../memory/privacy.js';
import { recordCopies } from './registry.js';

const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

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

/* ── Copies, at any depth ─────────────────────────────────────────────────── */

/** The records whose copies lose fields, as the walker reads them. */
export interface CopyTarget {
  /** The resource type audit and events name them by. */
  type: string;
  ids: ReadonlySet<string>;
  fields: readonly string[];
  /** Keys a command's input names them by: `id`, `<type>Id` and the set's `refs`. */
  refs: readonly string[];
  /** Approvals about them: every copy of one loses its summary and the fields in its input. */
  approvals: ReadonlySet<string>;
}

export function copyTarget(set: ErasedRecords, approvalIds: Iterable<string> = []): CopyTarget {
  return {
    type: set.type,
    ids: new Set(set.ids),
    fields: set.fields,
    refs: [...new Set(['id', `${set.type}Id`, ...(set.refs ?? [])])],
    approvals: new Set(approvalIds),
  };
}

/** An object without these keys; the same object when it has none of them. */
function strip(o: Obj, ks: readonly string[]): Obj {
  if (!ks.some((k) => Object.hasOwn(o, k))) return o;
  const out = { ...o };
  for (const k of ks) delete out[k];
  return out;
}

const idOf = (o: Obj, k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);

/** Does this object name one of the records by one of the input keys? */
const names = (o: Obj, t: CopyTarget) =>
  t.refs.some((k) => {
    const v = idOf(o, k);
    return v !== null && t.ids.has(v);
  });

/** Does this command input name one of the records anywhere? */
export function namesRecord(v: unknown, t: CopyTarget): boolean {
  if (Array.isArray(v)) return v.some((x) => namesRecord(x, t));
  if (!isObj(v)) return false;
  return names(v, t) || Object.values(v).some((x) => namesRecord(x, t));
}

/**
 * A copy of an approval about the records (the stored row, or as clients read it, with `input`
 * on top): without its summary, and its input without the records' fields. The input is the
 * record's own when the approval is on the record.
 */
function scrubApproval(o: Obj, t: CopyTarget): Obj {
  const resourceId = idOf(o, 'resourceId');
  const top = o.resourceType === t.type && resourceId !== null && t.ids.has(resourceId);
  let out = strip(o, ['summary']);
  if (Object.hasOwn(out, 'input')) {
    const input = walk(out.input, t, top, true);
    if (input !== out.input) out = { ...out, input };
  }
  const payload = out.payload;
  if (isObj(payload) && Object.hasOwn(payload, 'input')) {
    const input = walk(payload.input, t, top, true);
    if (input !== payload.input) out = { ...out, payload: { ...payload, input } };
  }
  return out;
}

/**
 * The walker: every object whose `id` is one of the records loses their fields (and, at the
 * top, the copy itself when it is the record); in a command's input, every object that names
 * one by an input key too. An approval about them, or anything pointing at one (a park's
 * `approvalId`), loses its summary. Unchanged values come back as they were (the same object).
 */
function walk(v: unknown, t: CopyTarget, top: boolean, input: boolean): unknown {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = walk(x, t, false, input);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (!isObj(v)) return v;
  let o = v;
  const id = idOf(o, 'id');
  if (id !== null && t.approvals.has(id)) o = scrubApproval(o, t);
  else if (top || (id !== null && t.ids.has(id)) || (input && names(o, t))) o = strip(o, t.fields);
  const approvalId = idOf(o, 'approvalId');
  if (approvalId !== null && t.approvals.has(approvalId)) o = strip(o, ['summary']);
  let changed = o !== v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(o)) {
    const y = walk(x, t, false, input);
    if (y !== x) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

/** A copy without the records' personal fields. `top`: the copy is one of the records. */
export const scrubCopy = (v: unknown, t: CopyTarget, top = false) => walk(v, t, top, false);

/** A command's input without the records' fields, wherever it names one. `top`: it is the record's. */
export const scrubInput = (v: unknown, t: CopyTarget, top = false) => walk(v, t, top, true);

const rowsOf = (r: unknown) => (r as { rows?: Obj[] }).rows ?? [];

/**
 * Write changed rows back, in one statement: `key` names the key columns with their types,
 * `cols` the jsonb columns written.
 */
async function writeBack(
  tx: Tx,
  table: string,
  key: readonly [string, string][],
  cols: readonly string[],
  rows: readonly Obj[],
): Promise<number> {
  if (!rows.length) return 0;
  const q = (c: string) => `"${c}"`;
  const spec = [...key.map(([c, type]) => `${q(c)} ${type}`), ...cols.map((c) => `${q(c)} jsonb`)];
  const set = cols.map((c) => `${q(c)} = v.${q(c)}`);
  const on = key.map(([c]) => `t.${q(c)} = v.${q(c)}`);
  await tx.execute(sql`
    update ${sql.raw(table)} as t set ${sql.raw(set.join(', '))}
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(${sql.raw(spec.join(', '))})
    where ${sql.raw(on.join(' and '))}`);
  return rows.length;
}

/** Rows whose jsonb column holds an object with one of these ids, at any depth. */
const holdsId = (col: SQL, ids: readonly string[]) =>
  sql`exists (select 1 from jsonb_path_query(${col}, 'lax $.**.id') as found(v)
    where found.v #>> '{}' in (${list(ids)}))`;

/** The approvals of this business about the records: on one of them, or naming one in their input. */
async function redactApprovals(
  tx: Tx,
  tenantId: string,
  set: ErasedRecords,
): Promise<{ about: Obj[]; changed: number }> {
  const t = copyTarget(set);
  const found = rowsOf(
    await tx.execute(sql`
      select id, resource_type, resource_id, summary, payload from app.approvals
      where tenant_id = ${tenantId}
        and ((resource_type = ${set.type} and resource_id in (${list(set.ids)}))
          or exists (select 1 from jsonb_path_query(payload -> 'input', 'lax $.**') as found(v)
            where jsonb_typeof(found.v) = 'string' and found.v #>> '{}' in (${list(set.ids)})))`),
  );
  const about: Obj[] = [];
  const changed: Obj[] = [];
  for (const row of found) {
    const own = row.resource_type === set.type && t.ids.has(String(row.resource_id ?? ''));
    const payload = isObj(row.payload) ? row.payload : null;
    if (!own && !namesRecord(payload?.input, t)) continue;
    about.push(row);
    const input = payload ? scrubInput(payload.input, t, own) : undefined;
    if (input === payload?.input && row.summary === null) continue;
    changed.push({
      id: row.id,
      payload: payload && input !== payload.input ? { ...payload, input } : row.payload,
    });
  }
  if (changed.length)
    await tx.execute(sql`
      update app.approvals set summary = null where id in (${list(changed.map((r) => String(r.id)))})`);
  return {
    about,
    changed: await writeBack(tx, 'app.approvals', [['id', 'text']], ['payload'], changed),
  };
}

const SLICE = 1000;

/** The resource type approvals are audited and stored under. */
const APPROVAL = 'approval';

/** A set in slices of at most `SLICE` ids. */
function slices(set: ErasedRecords): ErasedRecords[] {
  if (set.ids.length <= SLICE) return [set];
  const out: ErasedRecords[] = [];
  for (let i = 0; i < set.ids.length; i += SLICE)
    out.push({ ...set, ids: set.ids.slice(i, i + SLICE) });
  return out;
}

/**
 * Take the personal fields of these records out of every copy the server keeps of them, in this
 * business, and erase what is derived from them. `deleted`: the records are gone, so all their
 * files go; otherwise only the files of their personal fields. A copy is found by the record's
 * id at any depth (a reply's nested record, a notification's rows), and an approval about the
 * record (on it, or naming it in its input) loses its summary and input fields in every copy:
 * the approval, its audit rows and stored events, its notification, its parked reply and its
 * park's row, and each feature's copies of it (a decider's inbox item). The files erased with
 * the records are redacted the same way, as a `file` set. A set of approvals themselves (the
 * person's, deleted with them: `approvalCopies`) reaches the park's row on the record each was
 * about too. A `copiesOnly` set (records that stay, someone else's now) keeps its files and
 * memory vectors (decisions V8).
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
  // In slices: each statement names the ids, and a retention rule may hand over thousands.
  const queue = sets.flatMap(slices);
  for (let i = 0; i < queue.length; i++) {
    const set = queue[i];
    if (!set.ids.length) continue;
    const ids = list(set.ids);

    const approved = await redactApprovals(tx, tenantId, set);
    out.approvals += approved.changed;
    const approvalIds = approved.about.map((a) => String(a.id));
    const t = copyTarget(set, approvalIds);
    // An approval card's or a park's summary names the record ('Delete "Call Ravi"').
    const tAfter: CopyTarget = { ...t, fields: [...t.fields, 'summary'] };
    const own = (row: Obj) => row.resource_type === set.type && t.ids.has(String(row.resource_id));
    // The parks of approvals on other records (a comment's, on the record it is on).
    const parks = approved.about
      .filter((a) => !(a.resource_type === set.type && t.ids.has(String(a.resource_id))))
      .map(
        (a) =>
          sql`(resource_type = ${String(a.resource_type)} and ${
            a.resource_id === null
              ? sql`resource_id is null`
              : sql`resource_id = ${String(a.resource_id)}`
          } and after ->> 'approvalId' = ${String(a.id)})`,
      );
    const ofApprovals = approvalIds.length
      ? sql`or (resource_type = 'approval' and resource_id in (${list(approvalIds)}))`
      : sql``;
    // Approvals themselves (a person's, deleted with them): the park's row on the record each
    // was about names it by `approvalId`, and copies its summary.
    const asked = set.type === APPROVAL;
    const parkOf = (row: Obj) =>
      asked && isObj(row.after) && t.ids.has(String(row.after.approvalId ?? ''));

    const audit: Obj[] = [];
    for (const row of rowsOf(
      await tx.execute(sql`
        select id, resource_type, resource_id, before, after from audit.events
        where tenant_id = ${tenantId}
          and ((resource_type = ${set.type} and resource_id in (${ids})) ${ofApprovals}
            ${parks.length ? sql`or ${sql.join(parks, sql` or `)}` : sql``}
            ${asked ? sql`or after ->> 'approvalId' in (${ids})` : sql``})`),
    )) {
      const top = own(row) || parkOf(row);
      const before = scrubCopy(row.before, t, top);
      const after = scrubCopy(row.after, top ? tAfter : t, top);
      if (before !== row.before || after !== row.after) audit.push({ id: row.id, before, after });
    }
    out.audit += await writeBack(tx, 'audit.events', [['id', 'text']], ['before', 'after'], audit);

    const events: Obj[] = [];
    for (const row of rowsOf(
      await tx.execute(sql`
        select id, resource_type, resource_id, "row", before from app.domain_events
        where tenant_id = ${tenantId}
          and ((resource_type = ${set.type} and resource_id in (${ids})) ${ofApprovals})`),
    )) {
      const top = own(row);
      const r = scrubCopy(row.row, t, top);
      const before = scrubCopy(row.before, t, top);
      if (r !== row.row || before !== row.before) events.push({ id: row.id, row: r, before });
    }
    out.events += await writeBack(
      tx,
      'app.domain_events',
      [['id', 'text']],
      ['row', 'before'],
      events,
    );

    // Copies that carry the record (or an approval about it) somewhere inside.
    const held = [...set.ids, ...approvalIds];
    const scrubbed = (rows: Obj[], col: string) =>
      rows.flatMap((row) => {
        const v = scrubCopy(row[col], t);
        return v === row[col] ? [] : [{ ...row, [col]: v }];
      });
    out.notifications += await writeBack(
      tx,
      'app.outbox',
      [['id', 'bigint']],
      ['payload'],
      scrubbed(
        rowsOf(
          await tx.execute(sql`
            select id, payload from app.outbox
            where tenant_id = ${tenantId} and ${holdsId(sql`payload`, held)}`),
        ),
        'payload',
      ),
    );
    out.messages += await writeBack(
      tx,
      'channel.messages',
      [['id', 'text']],
      ['meta'],
      scrubbed(
        rowsOf(
          await tx.execute(sql`
            select id, meta from channel.messages
            where tenant_id = ${tenantId} and ${holdsId(sql`meta`, held)}`),
        ),
        'meta',
      ),
    );
    // The reply kept for a retry: the record as it was written, or the park. Its key names the
    // business (`<actor kind>:<actor id>:<tenant>:<subject>`).
    out.replies += await writeBack(
      tx,
      'app.idempotency',
      [
        ['key', 'text'],
        ['principal_id', 'text'],
      ],
      ['response'],
      scrubbed(
        rowsOf(
          await tx.execute(sql`
            select key, principal_id, response from app.idempotency
            where split_part(principal_id, ':', 3) = ${tenantId}
              and ${holdsId(sql`response`, held)}`),
        ),
        'response',
      ),
    );

    // A record that stays someone else's keeps its files and memory: only its copies change.
    if (!set.copiesOnly) {
      const def = entityDef(set.type);
      const fileFields = fileFieldsOf(def?.spec)
        .map(([f]) => f)
        .filter((f) => set.fields.includes(f));
      const files = await eraseFilesOn(tx, {
        tenantId,
        resourceType: set.type,
        ids: set.ids,
        ...(set.deleted ? {} : { fields: fileFields }),
      });
      out.files += files.length;
      // The files' own copies (their names in `file.*` audit rows) go the same way.
      if (files.length) queue.push(...slices(fileCopies(files)));
      out.memory += await forgetRecords(tx, { tenantId, resourceType: set.type, ids: set.ids });
    }
    // Each feature's own copies (webhook bodies, payloads, inbox items), of the records and of
    // the approvals about them: an approval's request in a decider's inbox repeats its summary
    // ('Rename "<name>"'), and its key names the approval (decisions V8).
    const about: ErasedRecords | null =
      approvalIds.length && !asked
        ? { type: APPROVAL, ids: approvalIds, fields: ['summary'] }
        : null;
    for (const copies of recordCopies.all())
      for (const one of about ? [set, about] : [set])
        for (const [where, n] of Object.entries(await copies.redact({ tx, tenantId, set: one })))
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
