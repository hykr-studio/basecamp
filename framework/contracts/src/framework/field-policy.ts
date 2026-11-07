// Field policy: fields only the holders of a capability may read (and write). Declared on a
// spec as a trait; @hykr/core's `field-policy` plugin removes the field wherever a record
// leaves for someone without it (API, tools, approvals, history, events), and refuses a list
// filter, a sort or a write on it.
import type { CommandSpec, EntitySpec } from './spec.js';

/**
 * Who may see one field: the capability that reads it, or `{ read, write }` when writing it
 * needs another one. Writing defaults to the read capability: nobody sets what they cannot see.
 */
export type FieldRule = string | { read: string; write?: string };

/** Field name → its rule. Top-level fields of the read schema (an entity) or output (a command). */
export type FieldPolicy = Readonly<Record<string, FieldRule>>;

declare module './traits.js' {
  interface EntityTraits {
    /** Fields only some capabilities read: `{ cost: 'orders.cost.read' }`. */
    fieldPolicy?: FieldPolicy;
  }
  interface CommandTraits {
    /** Fields of the command's output, and of its parked input, only some capabilities read. */
    fieldPolicy?: FieldPolicy;
  }
}

/** A spec's field policy, if it has one. */
export const fieldPolicyOf = (spec: EntitySpec | CommandSpec): FieldPolicy | undefined =>
  spec.traits?.fieldPolicy;

/** The capability a field needs, for reading or for writing. */
export function fieldCapability(rule: FieldRule, op: 'read' | 'write'): string {
  if (typeof rule === 'string') return rule;
  return op === 'write' ? (rule.write ?? rule.read) : rule.read;
}

/** Every capability a policy names. */
export const policyCapabilities = (policy: FieldPolicy): string[] => [
  ...new Set(
    Object.values(policy).flatMap((r) => [fieldCapability(r, 'read'), fieldCapability(r, 'write')]),
  ),
];

/**
 * The fields of this policy someone with these capabilities may not read (or write). No
 * capabilities: every field of the policy.
 */
export function hiddenFields(
  policy: FieldPolicy | undefined,
  held: { capabilities?: readonly string[] | null },
  op: 'read' | 'write' = 'read',
): string[] {
  if (!policy) return [];
  const have = new Set(held.capabilities ?? []);
  return Object.entries(policy)
    .filter(([, rule]) => !have.has(fieldCapability(rule, op)))
    .map(([field]) => field);
}

/** A record without these fields (a copy; the input is untouched). Removed, never blanked. */
export function withoutFields<T extends Record<string, unknown>>(
  value: T,
  fields: readonly string[],
): T {
  if (!fields.length) return value;
  const out = { ...value };
  for (const f of fields) delete out[f];
  return out;
}
