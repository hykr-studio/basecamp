// A spec's references (`traits.references`, V2): each id a write sets or changes names a record
// the writer can read in their business, or the write is refused, the same way whether the id is
// unknown, another business's, or one the writer cannot read. docs/decisions/V2.md.
import {
  type EntitySpec,
  type Principal,
  type ReferenceLabels,
  referenceLabelsOf,
  referencesOf,
} from '@hykr/contracts';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Conn } from '../tokens.js';
import { entityDef } from './registry.js';

type Values = Record<string, unknown>;
const log = new Logger('references');

/**
 * Load every reference this write sets to a value, or changes, through the target entity's own
 * scoped repository, as the writer (their business, the target's read access and its plugins'
 * scopes). Null always passes (an unlink), and so does an update that keeps the stored id.
 * Throws 404 `{ error: 'not_found', message: 'No such <target>', field }`.
 */
export async function checkReferences(
  conn: Conn,
  p: Principal,
  spec: EntitySpec,
  row: Values | null,
  input: Values,
): Promise<void> {
  for (const [field, entity] of referencesOf(spec)) {
    const id = input[field];
    if (id === undefined || id === null) continue;
    if (row && row[field] === id) continue;
    const target = entityDef(entity);
    // createCatalog refuses an unknown target at boot; an entity no module serves is a bug.
    if (!target) throw new Error(`${spec.name}.${field} names ${entity}, which is not served`);
    const found = typeof id === 'string' ? await target.repo.find(conn, p, id) : undefined;
    if (!found)
      throw new NotFoundException({
        error: 'not_found',
        message: `No such ${target.spec.label}`,
        field,
      });
  }
}

/**
 * Patches whose references a tree write already checked in bulk (`children.replace`), so
 * `repo.update` does not load them again one by one. Internal to the core.
 */
export const referencesChecked = new WeakSet<object>();

/** The most distinct ids of one target entity one bulk write may name (R1). */
export const MAX_REFERENCES = 1000;

/** One record of a bulk write, as its references are checked: its values, where it is. */
export interface ReferencingItem {
  values: Values;
  /** Where the record is in the write's input, e.g. `['items', 12]`; the field is appended. */
  path: readonly (string | number)[];
  /** The record's own key in the input, when it has one (a line's `ref`). */
  ref?: string;
}

/**
 * The bulk form of `checkReferences`, for records a write inserts together (a tree's new lines):
 * every reference each item sets, loaded with one query per target entity
 * (`target.repo.findMany`, as the writer), whatever the number of items. The first item whose id
 * is not found refuses the whole write, before anything is stored: 404 `{ error: 'not_found',
 * message: 'No such <target>', field, path, ref? }`. More than `MAX_REFERENCES` distinct ids of
 * one target: 400 `too_many_references`. Null and undefined pass.
 */
export async function checkReferencesMany(
  conn: Conn,
  p: Principal,
  spec: EntitySpec,
  items: readonly ReferencingItem[],
): Promise<void> {
  const refs = referencesOf(spec);
  if (!refs.length || !items.length) return;
  const wanted = new Map<string, { ids: Set<string>; field: string }>();
  for (const [field, entity] of refs)
    for (const item of items) {
      const id = item.values[field];
      if (id === undefined || id === null) continue;
      const w = wanted.get(entity) ?? { ids: new Set<string>(), field };
      wanted.set(entity, w);
      if (typeof id === 'string') w.ids.add(id);
    }
  const found = new Map<string, Set<string>>();
  for (const [entity, { ids, field }] of wanted) {
    const target = entityDef(entity);
    if (!target) throw new Error(`${spec.name}.${field} names ${entity}, which is not served`);
    if (ids.size > MAX_REFERENCES)
      throw new BadRequestException({
        error: 'too_many_references',
        message: `At most ${MAX_REFERENCES} different ${target.spec.plural} in one write`,
        field,
      });
    const rows = (await target.repo.findMany(conn, p, [...ids])) as Values[];
    found.set(entity, new Set(rows.map((r) => String(r.id))));
  }
  for (const item of items)
    for (const [field, entity] of refs) {
      const id = item.values[field];
      if (id === undefined || id === null) continue;
      if (typeof id === 'string' && found.get(entity)?.has(id)) continue;
      throw new NotFoundException({
        error: 'not_found',
        message: `No such ${entityDef(entity)?.spec.label ?? entity}`,
        field,
        path: [...item.path, field],
        ...(item.ref !== undefined ? { ref: item.ref } : {}),
      });
    }
}

/**
 * The labels of a page of records' references (R1), for a spec that declares any: one query per
 * target over the page's ids, as the reader (`findMany`), each label read from the target as the
 * reader may see it (`toRead`, so field policy applies). A target the reader cannot see, or a
 * label field hidden from them, reads `label: null`. Returns the reads with `references` added.
 */
export async function readReferences<R extends Values>(
  conn: Conn,
  p: Principal,
  spec: EntitySpec,
  reads: R[],
): Promise<(R & { references?: ReferenceLabels })[]> {
  const labelled = referenceLabelsOf(spec);
  if (!labelled.length || !reads.length) return reads;
  const byTarget = new Map<string, Set<string>>();
  for (const [field, entity] of labelled)
    for (const r of reads)
      if (typeof r[field] === 'string')
        byTarget.set(entity, (byTarget.get(entity) ?? new Set()).add(r[field] as string));
  const seen = new Map<string, Map<string, Values>>();
  for (const [entity, ids] of byTarget) {
    const target = entityDef(entity);
    if (!target) throw new Error(`${spec.name} reads ${entity}, which is not served`);
    const rows = await target.repo.findMany(conn, p, [...ids]);
    seen.set(
      entity,
      new Map(rows.map((row) => [String((row as Values).id), target.toRead(row, p) as Values])),
    );
  }
  return reads.map((r) => {
    const references: ReferenceLabels = {};
    for (const [field, entity, label] of labelled) {
      const id = r[field];
      if (typeof id !== 'string') continue;
      const value = seen.get(entity)?.get(id)?.[label];
      references[field] = {
        id,
        label: value === undefined || value === null ? null : String(value),
      };
    }
    return { ...r, references };
  });
}

/** The code of a Postgres error, also through drizzle's wrapper. */
const pgCode = (e: unknown): string | undefined => {
  const code =
    (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === 'string' ? code : undefined;
};

/** Postgres refused a write because a key it names, or that names it, is missing (23503). */
export const isForeignKeyViolation = (e: unknown) => pgCode(e) === '23503';

/**
 * A foreign key the database refused, said without its detail (no constraint, column or value,
 * which could name another business's record): a write naming a record that is gone is 404, a
 * delete of a record others still name is 409 `in_use`. Anything else is returned as it is.
 */
export function referenceRefusal(
  e: unknown,
  action: 'write' | 'delete',
  label = 'record',
): unknown {
  if (!isForeignKeyViolation(e)) return e;
  // The server's log keeps which key it was; the answer does not.
  const constraint =
    (e as { constraint?: unknown })?.constraint ??
    (e as { cause?: { constraint?: unknown } })?.cause?.constraint;
  log.warn(`a ${action} refused by the foreign key ${String(constraint ?? '(unnamed)')}`);
  if (action === 'delete')
    return new ConflictException({
      error: 'in_use',
      message: `Other records still name this ${label}`,
    });
  return new NotFoundException({ error: 'not_found', message: MISSING });
}

const MISSING = 'It names a record that does not exist';

/**
 * A write refused for a record it names (a declared reference's 404, with its field, or the
 * database's key's, without one), so a caller that reports it (an import) says both alike.
 */
export function refusedReference(e: unknown): { field: string | null; message: string } | null {
  if (!(e instanceof NotFoundException)) return null;
  const body = e.getResponse() as { error?: unknown; message?: unknown; field?: unknown };
  if (typeof body?.field === 'string' && typeof body.message === 'string')
    return { field: body.field, message: body.message };
  return body?.message === MISSING ? { field: null, message: MISSING } : null;
}
