// Versioned and frozen records (B4): a version counter for optimistic concurrency, states in
// which a record is frozen, and revisions (v1, v2, v3) as records of one series. Isomorphic: the
// server enforces them (the `versioned` plugin in @hykr/core), the apps show a lock and a
// version, and compare revisions with `diffFields` / `diffLists`. docs/decisions/B6B4.md.
import { z } from 'zod';
import type { EntitySpec } from './spec.js';

type Scalar = string | number | boolean | null;

export interface VersionedTrait {
  /** The integer column counting changes ('version', the default): `versionColumn()`. */
  field?: string;
  /**
   * When a record is frozen: a field and the values that freeze it ({ status: ['approved'] }).
   * Several fields: any one of them. A frozen record refuses every delete and every update but a
   * move of its state field and `editableWhenFrozen`; its children refuse every write.
   */
  frozenWhen?: Readonly<Record<string, readonly Scalar[]>>;
  /** Fields a frozen record may still change (a note). */
  editableWhenFrozen?: readonly string[];
  /**
   * Revisions: each one a record of its own in one series (`revisionColumns()`): `series`
   * holds the first revision's id (null on the first itself), `number` counts 1, 2, 3.
   */
  revisions?: { series?: string; number?: string };
}

declare module './traits.js' {
  interface EntityTraits {
    versioned?: VersionedTrait;
  }
}

/** The spec's versioning, if it has one. */
export const versionedOf = (spec: Pick<EntitySpec, 'traits'>): VersionedTrait | undefined =>
  spec.traits?.versioned;

/** The field holding the version. */
export const versionField = (trait: VersionedTrait): string => trait.field ?? 'version';

/** The fields holding a revision's series and number, when the trait has revisions. */
export const revisionFields = (
  trait: VersionedTrait,
): { series: string; number: string } | undefined =>
  trait.revisions
    ? { series: trait.revisions.series ?? 'seriesId', number: trait.revisions.number ?? 'revision' }
    : undefined;

/** Is this record frozen? */
export function isFrozen(
  trait: VersionedTrait | undefined,
  row: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  if (!trait?.frozenWhen || !row) return false;
  return Object.entries(trait.frozenWhen).some(([field, values]) =>
    (values as readonly unknown[]).includes(row[field] as Scalar),
  );
}

/**
 * Check a spec's versioning: the version field is in the read schema, and a frozen state field
 * is one the record has. Throws, so a typo stops the start.
 */
export function checkVersioned(spec: EntitySpec): void {
  const trait = versionedOf(spec);
  if (!trait) return;
  const read = spec.schemas.read.shape as Record<string, unknown>;
  const problems: string[] = [];
  if (!(versionField(trait) in read))
    problems.push(`the read schema has no "${versionField(trait)}"`);
  for (const field of Object.keys(trait.frozenWhen ?? {}))
    if (!(field in read)) problems.push(`it is frozen by "${field}", not in the read schema`);
  const rev = revisionFields(trait);
  if (rev)
    for (const field of [rev.series, rev.number])
      if (!(field in read)) problems.push(`the read schema has no "${field}" (revisions)`);
  if (problems.length) throw new Error(`${spec.name}'s versions: ${problems.join('; ')}`);
}

/** One revision of a record, as the versions list gives it. */
export const RecordVersion = z.object({
  id: z.string(),
  /** 1, 2, 3: the revision; 1 when the entity has no revisions. */
  revision: z.number().int(),
  /** How many times this revision was written. */
  version: z.number().int(),
  frozen: z.boolean(),
  /** Its state, when the entity has states. */
  state: z.string().nullable(),
  /** The one asked about. */
  current: z.boolean(),
  /** The record as the entity reads it for this person. */
  record: z.record(z.string(), z.unknown()),
});
export type RecordVersion = z.infer<typeof RecordVersion>;

/** A field that differs between two records. */
export type FieldChange = { field: string; before: unknown; after: unknown };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What every revision has of its own: ids (and fields pointing at ids), provenance, counters. */
const META = new Set(['createdAt', 'updatedAt', 'createdBy', 'version', 'revision']);
const ownOfEach = (k: string) => k === 'id' || k.endsWith('Id') || META.has(k);

/**
 * The fields that differ between two records (by value, as JSON), in the order the second one
 * lists them. Ids and fields ending in "Id", provenance, the version and the revision are left
 * out (each revision has its own); `ignore` leaves out more.
 */
export function diffFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  opts: { ignore?: readonly string[] } = {},
): FieldChange[] {
  const ignore = new Set(opts.ignore ?? []);
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  return keys
    .filter((k) => !ownOfEach(k) && !ignore.has(k) && !same(before[k], after[k]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

/** Two lists of records compared by a key: what was added, removed and changed. */
export interface ListDiff<T> {
  added: T[];
  removed: T[];
  changed: { before: T; after: T; fields: FieldChange[] }[];
  unchanged: number;
}

/**
 * Compare two lists (a revision's lines against the one before), matching items by a key
 * (a title path, not an id: a revision's copies have new ids). Repeated keys pair up in order.
 */
export function diffLists<T extends Readonly<Record<string, unknown>>>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
  opts: { ignore?: readonly string[] } = {},
): ListDiff<T> {
  const pool = new Map<string, T[]>();
  for (const b of before) pool.set(keyOf(b), [...(pool.get(keyOf(b)) ?? []), b]);
  const out: ListDiff<T> = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const a of after) {
    const match = pool.get(keyOf(a))?.shift();
    if (!match) {
      out.added.push(a);
      continue;
    }
    const fields = diffFields(match, a, opts);
    if (fields.length) out.changed.push({ before: match, after: a, fields });
    else out.unchanged++;
  }
  for (const rest of pool.values()) out.removed.push(...rest);
  return out;
}
