// Per-record grants: the `granted` access rule reaches the records granted to a person one by
// one (app.record_grants), or the children of such a record (`via` a column). The members
// feature contributes these; a business grants and revokes through /api/grants.
import { type DbOrTx, recordGrants } from '@hykr/db';
import { subjectOf } from '@hykr/policy';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { GrantKind, GrantTarget, WriteHook } from '../hooks.js';

/** The column a `granted` rule points through: the row's own id, or a parent's. */
function viaColumn(rule: { via?: string }, target: GrantTarget) {
  const key = rule.via ?? 'id';
  const column = target.columns[key];
  if (!column) throw new Error(`${target.spec.name}: access grant via "${key}" is not a column`);
  return column;
}

/** Does this person hold a grant on this record, in this business? */
export async function holdsGrant(
  db: DbOrTx,
  g: { tenantId: string; resourceType: string; resourceId: string; userId: string },
): Promise<boolean> {
  const [hit] = await db
    .select({ id: recordGrants.id })
    .from(recordGrants)
    .where(
      and(
        eq(recordGrants.tenantId, g.tenantId),
        eq(recordGrants.userId, g.userId),
        eq(recordGrants.resourceType, g.resourceType),
        eq(recordGrants.resourceId, g.resourceId),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

/**
 * `{ grant: 'granted', of?, via? }`: rows whose `via` column (default: id) names a record of type
 * `of` (default: this entity) granted to the person, in the row's own business. Only a person
 * holds grants. A child row may be created under a parent granted to them; a top-level one not.
 */
export const recordGrantKind: GrantKind = {
  name: 'granted',
  where(p, rule, target) {
    const subject = subjectOf(p);
    if (subject?.kind !== 'user') return undefined;
    const via = viaColumn(rule, target);
    const tenant = target.columns.tenantId;
    return sql`exists (select 1 from ${recordGrants} where ${recordGrants.tenantId} = ${tenant} and ${recordGrants.userId} = ${subject.userId} and ${recordGrants.resourceType} = ${rule.of ?? target.spec.name} and ${recordGrants.resourceId} = ${via})`;
  },
  async creates(tx, p, rule, input, target) {
    const subject = subjectOf(p);
    const key = rule.via ?? 'id';
    viaColumn(rule, target);
    const parent = input[key];
    if (subject?.kind !== 'user' || key === 'id' || typeof parent !== 'string' || !p.tenantId)
      return false;
    return holdsGrant(tx, {
      tenantId: p.tenantId,
      userId: subject.userId,
      resourceType: rule.of ?? target.spec.name,
      resourceId: parent,
    });
  },
};

/**
 * A deleted record's grants go with it, in the same transaction, whichever write deleted it
 * (a CRUD delete, or a command's `touched`).
 */
export const grantsCleanup: WriteHook = {
  name: 'grants',
  async afterRun({ tx, touched, result, ctx }) {
    if (result.status !== 'done' || !ctx.principal.tenantId) return;
    const gone = touched.filter((t) => t.change === 'deleted');
    for (const type of new Set(gone.map((t) => t.type))) {
      const ids = gone.filter((t) => t.type === type).map((t) => t.id);
      await tx
        .delete(recordGrants)
        .where(
          and(
            eq(recordGrants.tenantId, ctx.principal.tenantId),
            eq(recordGrants.resourceType, type),
            inArray(recordGrants.resourceId, ids),
          ),
        );
    }
  },
};
