// The `participant` access rule: the records a party the person (or contact) is a member of
// participates in (app.participations), in the participant roles the rule names, or the children
// of such records (`via` a column). The parties feature contributes these.
import { participantRoles, type Subject } from '@hykr/contracts';
import { contacts, type DbOrTx, participations, partyMembers } from '@hykr/db';
import { subjectOf } from '@hykr/policy';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { GrantKind, GrantTarget, WriteHook } from '../hooks.js';

/** The column a `participant` rule points through: the row's own id, or a parent's. */
function viaColumn(rule: { via?: string }, target: GrantTarget) {
  const key = rule.via ?? 'id';
  const column = target.columns[key];
  if (!column)
    throw new Error(`${target.spec.name}: access participant via "${key}" is not a column`);
  return column;
}

/** The roles a rule names, checked: one nobody declares throws (a typo would reach nothing). */
function rolesOf(rule: { as?: readonly string[] }, target: GrantTarget): readonly string[] | null {
  if (!rule.as) return null;
  for (const r of rule.as)
    if (!participantRoles.has(r))
      throw new Error(
        `${target.spec.name}: access names participant role "${r}", which nobody declares`,
      );
  return rule.as;
}

/**
 * The party members a subject is, in the business `tenant` (an SQL column or value): a person by
 * account (joined) or by a number linked to their account there; a contact by itself.
 */
function membersOf(subject: Subject, tenant: unknown): SQL {
  if (subject.kind === 'contact') return sql`${partyMembers.contactId} = ${subject.contactId}`;
  return sql`((${partyMembers.userId} = ${subject.userId} and ${partyMembers.joinedAt} is not null)
    or ${partyMembers.contactId} in (select ${contacts.id} from ${contacts}
      where ${contacts.userId} = ${subject.userId} and ${contacts.tenantId} = ${tenant}))`;
}

/** Does this subject participate in this record (in one of these roles), in this business? */
export async function participates(
  db: DbOrTx,
  g: {
    tenantId: string;
    resourceType: string;
    resourceId: string;
    subject: Subject;
    roles?: readonly string[] | null;
  },
): Promise<boolean> {
  const [hit] = await db
    .select({ id: participations.id })
    .from(participations)
    .innerJoin(partyMembers, eq(partyMembers.partyId, participations.partyId))
    .where(
      and(
        eq(participations.tenantId, g.tenantId),
        eq(participations.resourceType, g.resourceType),
        eq(participations.resourceId, g.resourceId),
        g.roles ? inArray(participations.role, [...g.roles]) : undefined,
        membersOf(g.subject, g.tenantId),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

/**
 * `{ grant: 'participant', as?, of?, via? }`: rows whose `via` column (default: id) names a record
 * of type `of` (default: this entity) that a party the subject is a member of participates in,
 * in one of the roles `as` names (default: any), in the row's own business. A person may create a
 * child row under such a record (they own it); a top-level one, or a contact, not.
 */
export const participantGrantKind: GrantKind = {
  name: 'participant',
  where(p, rule, target) {
    const subject = subjectOf(p);
    if (!subject) return undefined;
    const via = viaColumn(rule, target);
    const roles = rolesOf(rule, target);
    if (roles && !roles.length) return undefined;
    const tenant = target.columns.tenantId;
    const inRoles = roles
      ? sql` and ${participations.role} in (${sql.join(
          roles.map((r) => sql`${r}`),
          sql`, `,
        )})`
      : sql``;
    return sql`exists (select 1 from ${participations} inner join ${partyMembers} on ${partyMembers.partyId} = ${participations.partyId} where ${participations.tenantId} = ${tenant} and ${participations.resourceType} = ${rule.of ?? target.spec.name} and ${participations.resourceId} = ${via}${inRoles} and ${membersOf(subject, tenant)})`;
  },
  async creates(tx, p, rule, input, target) {
    const subject = subjectOf(p);
    const key = rule.via ?? 'id';
    viaColumn(rule, target);
    const parent = input[key];
    if (subject?.kind !== 'user' || key === 'id' || typeof parent !== 'string' || !p.tenantId)
      return false;
    return participates(tx, {
      tenantId: p.tenantId,
      resourceType: rule.of ?? target.spec.name,
      resourceId: parent,
      subject,
      roles: rolesOf(rule, target),
    });
  },
};

/**
 * A deleted record's participations go with it, in the same transaction, whichever write deleted
 * it (a CRUD delete, or a command's `touched`).
 */
export const participationsCleanup: WriteHook = {
  name: 'participations',
  async afterRun({ tx, touched, result, ctx }) {
    if (result.status !== 'done' || !ctx.principal.tenantId) return;
    const gone = touched.filter((t) => t.change === 'deleted');
    for (const type of new Set(gone.map((t) => t.type))) {
      const ids = gone.filter((t) => t.type === type).map((t) => t.id);
      await tx
        .delete(participations)
        .where(
          and(
            eq(participations.tenantId, ctx.principal.tenantId),
            eq(participations.resourceType, type),
            inArray(participations.resourceId, ids),
          ),
        );
    }
  },
};
