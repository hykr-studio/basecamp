import type { Conn, Tx } from '@hykr/core';
import {
  type DataSubject,
  type ErasedRecords,
  type ErasureResult,
  erasureContributors,
  exportContributors,
  type KeptData,
} from '../hooks.js';

/** What every erasure contributor did for one subject. */
export interface ContributorsErasure {
  /** Each contributor's count, by name, for the audit row. */
  counts: Record<string, number>;
  /** The records they deleted or blanked, whose copies the erasure redacts. */
  erased: ErasedRecords[];
  /** What they kept on purpose, and why. */
  kept: KeptData[];
  /** Their work outside the database, for once the erasure has committed. */
  afterCommit: NonNullable<ErasureResult['afterCommit']>[];
}

/**
 * Every erasure contributor, in order, inside the erasure's transaction: what each feature holds
 * about this person goes with the rest, or none of it does.
 */
export async function eraseWithContributors(
  a: DataSubject & { tx: Tx },
): Promise<ContributorsErasure> {
  const out: ContributorsErasure = { counts: {}, erased: [], kept: [], afterCommit: [] };
  for (const c of erasureContributors.all()) {
    const r = await c.erase(a);
    out.counts[c.name] = r.count;
    out.erased.push(...(r.erased ?? []).filter((s) => s.ids.length));
    out.kept.push(...(r.kept ?? []).filter((k) => k.count > 0));
    if (r.afterCommit) out.afterCommit.push(r.afterCommit);
  }
  return out;
}

/**
 * Everything the export contributors hold about this person, by kind ({ files: [...] }). Two
 * contributors that return the same kind stop the export instead of one hiding the other.
 */
export async function exportPersonalData(
  a: DataSubject & { db: Conn },
): Promise<Record<string, readonly unknown[]>> {
  const out: Record<string, readonly unknown[]> = {};
  const from: Record<string, string> = {};
  for (const c of exportContributors.all()) {
    for (const [kind, records] of Object.entries(await c.export(a))) {
      if (from[kind])
        throw new Error(`Both ${from[kind]} and ${c.name} export "${kind}": rename one kind`);
      from[kind] = c.name;
      out[kind] = records;
    }
  }
  return out;
}
