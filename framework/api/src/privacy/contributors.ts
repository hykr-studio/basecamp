import type { Conn, Tx } from '@hykr/core';
import { events as auditEvents } from '@hykr/db';
import { and, eq, or, type SQL } from 'drizzle-orm';
import {
  type DataSubject,
  type ErasedRecords,
  type ErasureResult,
  erasureContributors,
  exportContributors,
  type KeptData,
} from '../hooks.js';

/**
 * The ids of the records of this type a person created (their `<type>.create` audit rows, as
 * themselves or through their assistant), in one business or every one. A contributor erases
 * the copies of these too: a record they deleted before is gone, but its copies are not
 * (decisions V8).
 */
export async function createdBy(
  conn: Conn,
  a: { type: string; userId: string; tenantId?: string },
): Promise<string[]> {
  const rows = await conn
    .selectDistinct({ id: auditEvents.resourceId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.resourceType, a.type),
        eq(auditEvents.action, `${a.type}.create`),
        or(
          and(eq(auditEvents.actorKind, 'user'), eq(auditEvents.actorId, a.userId)),
          eq(auditEvents.actingFor, a.userId),
          eq(auditEvents.actingFor, `user:${a.userId}`),
        ),
        a.tenantId ? eq(auditEvents.tenantId, a.tenantId) : undefined,
      ) as SQL,
    );
  return rows.flatMap((r) => (r.id ? [r.id] : []));
}

/** These ids and those, once each. */
export const both = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

/** What every erasure contributor did for one subject. */
export interface ContributorsErasure {
  /** Each contributor's count, by name, for the audit row. */
  counts: Record<string, number>;
  /** The records they deleted or blanked, whose copies the erasure redacts. */
  erased: ErasedRecords[];
  /** What they kept on purpose, and why. */
  kept: KeptData[];
  /** Assistant runs whose turns they erased: Mastra's rows of them go too. */
  runs: string[];
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
  const out: ContributorsErasure = { counts: {}, erased: [], kept: [], runs: [], afterCommit: [] };
  for (const c of erasureContributors.all()) {
    const r = await c.erase(a);
    out.counts[c.name] = r.count;
    out.erased.push(...(r.erased ?? []).filter((s) => s.ids.length));
    out.kept.push(...(r.kept ?? []).filter((k) => k.count > 0));
    out.runs.push(...(r.runs ?? []));
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
