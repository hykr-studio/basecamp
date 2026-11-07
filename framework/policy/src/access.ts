import {
  type Assurance,
  atLeast,
  CAPABILITY_NAME,
  capabilities,
  type Principal,
} from '@hykr/contracts';
import { subjectOf } from './subject.js';

/**
 * How a rule reaches an entity's rows. Built in: the person's own (the owner column is them),
 * the customer's (the customer column is theirs), the whole tenant, `granted`: the records
 * granted to the person one by one (`app.record_grants`), or the children of such records, and
 * `participant`: the records a party they are a member of participates in (`app.participations`),
 * in the participant roles `as` names, or the children of such records.
 * Open: a feature adds a kind by declaration merging and registers its SQL (`grantKinds` in
 * @hykr/core). Rows are always limited to the principal's tenant first.
 */
export interface GrantKinds {
  own: true;
  customer: true;
  tenant: true;
  granted: true;
  participant: true;
}
export type Grant = keyof GrantKinds & string;

/** The kinds `define-entity` answers itself; any other is a registered grant kind's. */
export const BUILTIN_GRANTS: readonly string[] = ['own', 'customer', 'tenant'];
export const isBuiltinGrant = (g: string) => BUILTIN_GRANTS.includes(g);

/** A grant with its options. */
export interface GrantRule {
  grant: Grant;
  /** A write needs this much assurance (a WhatsApp number alone is refused 'session'). */
  minAssurance?: Assurance;
  /**
   * `granted`, `participant`: the resource type the grant (or participation) is on. Default:
   * this entity's name. A child names its parent's ('project'), with `via`.
   */
  of?: string;
  /**
   * `granted`, `participant`: the column (its key) holding the granted (or participated) record's
   * id. Default: 'id'.
   */
  via?: string;
  /**
   * `participant`: only participations in these participant roles (declared by the application,
   * `participantRoles` in @hykr/contracts). Default: any role.
   */
  as?: readonly string[];
}

/** One way in, or several (ORed): `['own', { grant: 'granted' }]`. */
export type AccessRule = Grant | GrantRule | readonly (Grant | GrantRule)[];

/**
 * Per role name (a registered role, see `roles` in @hykr/contracts) or per capability (a dotted
 * name: everyone holding it): what it reaches. A role a business made reaches rows only through
 * the capabilities it holds.
 */
export type RoleAccess = Readonly<Record<string, AccessRule>>;

/** An entity's access: who reads which rows, who writes which. */
export type Access = { read: RoleAccess; write: RoleAccess };

/** The default: everyone works on their own rows; customers on theirs. */
export const DEFAULT_ACCESS: Access = {
  read: { owner: 'own', admin: 'own', ops: 'own', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'own', ops: 'own', staff: 'own', customer: 'customer' },
};

export type AccessDecision =
  /** `grants`: each kind once; `rules`: every rule that gave one, with its options. */
  | { kind: 'grants'; grants: Grant[]; rules: GrantRule[] }
  /** A role would allow it, but only with a stronger assurance (a signed-in account). */
  | { kind: 'needs_assurance'; need: Assurance }
  | { kind: 'none' };

const rulesOf = (rule: AccessRule): GrantRule[] =>
  (Array.isArray(rule)
    ? (rule as readonly (Grant | GrantRule)[])
    : [rule as Grant | GrantRule]
  ).map((r) => (typeof r === 'string' ? { grant: r } : r));

/**
 * The access keys that apply to this principal: its roles, then the capabilities it holds
 * that the map names. A capability key nobody defines throws: a typo must not quietly reach
 * nothing (or, after a later definition, more than meant).
 */
function keysOf(p: Principal, rules: RoleAccess): string[] {
  const keys: string[] = [...(p.roles ?? [])];
  const held = new Set(p.capabilities ?? []);
  for (const key of Object.keys(rules)) {
    if (!CAPABILITY_NAME.test(key)) continue;
    if (!capabilities.has(key))
      throw new Error(`Access names capability "${key}", which nobody defines`);
    if (held.has(key)) keys.push(key);
  }
  return keys;
}

/**
 * What this principal's roles (and capabilities) allow, for reading or writing. A grant only
 * counts if the principal has what it needs: 'own' and 'granted' a person with an account,
 * 'participant' a person or a contact, 'customer' a customer record. The server's own background work (`systemPrincipal()`, never
 * from a request) reaches every row of its one business; entity rules, approvals and audit
 * still apply to it. Pure: reads roles, capabilities, subject, customer and assurance.
 */
export function accessFor(p: Principal, access: Access, op: 'read' | 'write'): AccessDecision {
  if (p.actor.kind === 'system')
    return p.tenantId
      ? { kind: 'grants', grants: ['tenant'], rules: [{ grant: 'tenant' }] }
      : { kind: 'none' };
  const map = access[op];
  const subject = subjectOf(p);
  const grants = new Set<Grant>();
  const given: GrantRule[] = [];
  let need: Assurance | undefined;
  for (const key of keysOf(p, map)) {
    const rule = Object.hasOwn(map, key) ? map[key] : undefined;
    if (!rule) continue;
    for (const r of rulesOf(rule)) {
      if ((r.grant === 'own' || r.grant === 'granted') && subject?.kind !== 'user') continue;
      // A participant is a person or a contact: nobody else participates.
      if (r.grant === 'participant' && !subject) continue;
      if (r.grant === 'customer' && !p.customerId) continue;
      if (r.minAssurance && !atLeast(p.assurance, r.minAssurance)) {
        need = r.minAssurance;
        continue;
      }
      grants.add(r.grant);
      given.push(r);
    }
  }
  if (grants.size > 0) return { kind: 'grants', grants: [...grants], rules: given };
  return need ? { kind: 'needs_assurance', need } : { kind: 'none' };
}

/**
 * Does one row fall inside these grants? (For writes on a row already loaded.) A kind the
 * framework does not answer itself (`granted`, a feature's) needs a query: it counts as inside
 * here, and the write's own scoped query refuses the row (404) when it is not.
 */
export function rowAllowed(
  p: Principal,
  grants: Grant[],
  row: { ownerId?: unknown; customerId?: unknown },
): boolean {
  const subject = subjectOf(p);
  return grants.some(
    (g) =>
      g === 'tenant' ||
      !isBuiltinGrant(g) ||
      (g === 'own' && subject?.kind === 'user' && row.ownerId === subject.userId) ||
      (g === 'customer' && p.customerId !== undefined && row.customerId === p.customerId),
  );
}
