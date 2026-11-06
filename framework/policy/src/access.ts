import { type Assurance, atLeast, type Principal } from '@hykr/contracts';
import { subjectOf } from './subject.js';

/**
 * How a role reaches an entity's rows: its own (the owner column is the person), the
 * customer's (the customer column is theirs), or the whole tenant. Rows are always limited to
 * the principal's tenant first.
 */
export type Grant = 'own' | 'customer' | 'tenant';
export type AccessRule = Grant | { grant: Grant; minAssurance?: Assurance };
/** Per role name (a registered role, see `roles` in @hykr/contracts): what it reaches. */
export type RoleAccess = Readonly<Record<string, AccessRule>>;

/** An entity's access: who reads which rows, who writes which. */
export type Access = { read: RoleAccess; write: RoleAccess };

/** The default: everyone works on their own rows; customers on theirs. */
export const DEFAULT_ACCESS: Access = {
  read: { owner: 'own', admin: 'own', ops: 'own', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'own', ops: 'own', staff: 'own', customer: 'customer' },
};

export type AccessDecision =
  | { kind: 'grants'; grants: Grant[] }
  /** A role would allow it, but only with a stronger assurance (a signed-in account). */
  | { kind: 'needs_assurance'; need: Assurance }
  | { kind: 'none' };

/**
 * What this principal's roles allow, for reading or writing. A grant only counts if the
 * principal has what it needs: 'own' a person with an account, 'customer' a customer record.
 * The server's own background work (`systemPrincipal()`, never from a request) reaches every
 * row of its one business; entity rules, approvals and audit still apply to it.
 * Pure: reads roles, subject, customer and assurance; never addresses or phone numbers.
 */
export function accessFor(p: Principal, access: Access, op: 'read' | 'write'): AccessDecision {
  if (p.actor.kind === 'system')
    return p.tenantId ? { kind: 'grants', grants: ['tenant'] } : { kind: 'none' };
  const rules = access[op];
  const subject = subjectOf(p);
  const grants = new Set<Grant>();
  let need: Assurance | undefined;
  for (const role of p.roles ?? []) {
    const rule = Object.hasOwn(rules, role) ? rules[role] : undefined;
    if (!rule) continue;
    const { grant, minAssurance } = typeof rule === 'string' ? { grant: rule } : rule;
    if (grant === 'own' && subject?.kind !== 'user') continue;
    if (grant === 'customer' && !p.customerId) continue;
    if (minAssurance && !atLeast(p.assurance, minAssurance)) {
      need = minAssurance;
      continue;
    }
    grants.add(grant);
  }
  if (grants.size > 0) return { kind: 'grants', grants: [...grants] };
  return need ? { kind: 'needs_assurance', need } : { kind: 'none' };
}

/** Does one row fall inside these grants? (For writes on a row already loaded.) */
export function rowAllowed(
  p: Principal,
  grants: Grant[],
  row: { ownerId?: unknown; customerId?: unknown },
): boolean {
  const subject = subjectOf(p);
  return grants.some(
    (g) =>
      g === 'tenant' ||
      (g === 'own' && subject?.kind === 'user' && row.ownerId === subject.userId) ||
      (g === 'customer' && p.customerId !== undefined && row.customerId === p.customerId),
  );
}
