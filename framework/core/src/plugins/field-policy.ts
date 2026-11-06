// Field policy: a spec's `traits.fieldPolicy` names fields only some capabilities read (and
// write). The plugin removes them from every record that leaves for someone without the
// capability (toRead: lists, gets, write and command results, approvals, history, events),
// refuses a list filter or sort on them, and refuses a write to them on every path.
import {
  type EntitySpec,
  type FieldPolicy,
  fieldPolicyOf,
  hiddenFields,
  type Principal,
  withoutFields,
} from '@hykr/contracts';
import { ForbiddenException } from '@nestjs/common';
import { deny, RuleDenied } from '../authorize.js';
import type { EntityPlugin } from '../hooks.js';

type Values = Record<string, unknown>;

const labelOf = (spec: EntitySpec, field: string) => spec.fieldLabels?.[field]?.en ?? field;

/** The fields of this input p may not set (a value of undefined is not a write). */
function unwritable(policy: FieldPolicy | undefined, p: Principal, input: Values | null) {
  if (!policy || !input) return [];
  return hiddenFields(policy, p, 'write').filter((f) => input[f] !== undefined);
}

const refusal = (spec: EntitySpec, fields: string[]) =>
  deny(
    'field_hidden',
    `You can't set ${fields.map((f) => labelOf(spec, f)).join(', ')} on a ${spec.label}`,
  );

/**
 * Problems with an entity's policy, for the start: each field must be in the read schema and
 * optional there (it is removed, so the client type must allow its absence), and neither
 * searched nor sorted by default (`q` and a cursor would reveal it).
 */
export function fieldPolicyProblems(spec: EntitySpec, known: (cap: string) => boolean): string[] {
  const policy = fieldPolicyOf(spec);
  if (!policy) return [];
  const problems: string[] = [];
  const shape = spec.schemas.read.shape as Record<
    string,
    { safeParse(v: unknown): { success: boolean } }
  >;
  for (const [field, rule] of Object.entries(policy)) {
    const where = `${spec.name}: field policy on "${field}"`;
    const schema = shape[field];
    if (!schema) problems.push(`${where}: the read schema has no such field`);
    else if (!schema.safeParse(undefined).success)
      problems.push(`${where}: make it optional in the read schema (it is removed when hidden)`);
    if (spec.list.search?.includes(field)) problems.push(`${where}: it cannot be searched (q)`);
    if (spec.list.defaultSort.some(([f]) => f === field))
      problems.push(`${where}: it cannot be in defaultSort`);
    for (const cap of typeof rule === 'string' ? [rule] : [rule.read, rule.write ?? rule.read])
      if (!known(cap)) problems.push(`${where}: "${cap}" is not a capability`);
  }
  return problems;
}

/** The entity plugin. Contributed by the members feature. */
export const fieldPolicyPlugin: EntityPlugin = {
  name: 'field-policy',
  appliesTo: (spec) => fieldPolicyOf(spec) !== undefined,
  // A plain CRUD write: refused before anything runs, audited as denied.
  decide(p, _action, _row, input, { spec }) {
    const fields = unwritable(fieldPolicyOf(spec), p, input);
    return fields.length ? refusal(spec, fields) : null;
  },
  // A command writing through the repository: the same refusal, from inside its run.
  toValues(values, { p, input }, { spec }) {
    const fields = unwritable(fieldPolicyOf(spec), p, input);
    if (fields.length) throw new RuleDenied(refusal(spec, fields));
    return values;
  },
  project: (read, p, { spec }) => withoutFields(read, hiddenFields(fieldPolicyOf(spec), p)),
  query(q, p, { spec }) {
    const hidden = new Set(hiddenFields(fieldPolicyOf(spec), p));
    if (!hidden.size) return;
    const asked = [...q.filters.map((f) => f.field), ...q.sort.map((s) => s.field)];
    const field = asked.find((f) => hidden.has(f));
    if (field)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'field_hidden',
        reason: `You can't filter or sort ${spec.plural} by ${labelOf(spec, field)}`,
      });
  },
};
