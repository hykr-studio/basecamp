import type { Conn, Tx } from '@hykr/core';
import { type DataSubject, erasureContributors, exportContributors } from '../hooks.js';

/**
 * Every erasure contributor, in order, inside the erasure's transaction: what each feature holds
 * about this person goes with the rest, or none of it does. Returns each contributor's count, by
 * name, for the audit row.
 */
export async function eraseWithContributors(
  a: DataSubject & { tx: Tx },
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const c of erasureContributors.all()) counts[c.name] = (await c.erase(a)).count;
  return counts;
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
