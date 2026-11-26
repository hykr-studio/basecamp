// Field policy on commands, and the start-up check of every policy. Entities are covered by the
// core's `field-policy` entity plugin; a command's own output fields and its parked input are
// covered here, as a read projector by the command's name and for 'approval'.
import {
  capabilities,
  fieldPolicyOf,
  hiddenFields,
  type Principal,
  withoutFields,
} from '@hykr/contracts';
import { entityDefs, fieldPolicyProblems, type ReadProjector } from '@hykr/core';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { runtime } from '../../runtime.js';

type Values = Record<string, unknown>;

/** The command of this name, if the application declares one with a field policy. */
const policyOf = (name: string) => {
  const spec = runtime().catalog.commandByName(name);
  return spec ? fieldPolicyOf(spec) : undefined;
};

/**
 * A command's result without the fields its policy hides from p; an approval of that command
 * without them in its parked input.
 */
export const commandFieldPolicy: ReadProjector = {
  name: 'field-policy',
  project(resourceType: string, value: Values, p: Principal): Values {
    if (resourceType === 'approval') {
      const policy = policyOf(String(value.action ?? ''));
      const input = value.input;
      if (!policy || !input || typeof input !== 'object' || Array.isArray(input)) return value;
      return { ...value, input: withoutFields(input as Values, hiddenFields(policy, p)) };
    }
    const policy = policyOf(resourceType);
    return policy ? withoutFields(value, hiddenFields(policy, p)) : value;
  },
};

/** Every field policy is checked when the API or worker starts: a mistake stops it. */
@Injectable()
export class FieldPolicyCheck implements OnApplicationBootstrap {
  onApplicationBootstrap() {
    const known = (cap: string) => capabilities.has(cap);
    const problems = entityDefs().flatMap((d) => fieldPolicyProblems(d.spec, known));
    for (const spec of runtime().catalog.commands) {
      const policy = fieldPolicyOf(spec);
      if (!policy) continue;
      for (const [field, rule] of Object.entries(policy))
        for (const cap of typeof rule === 'string' ? [rule] : [rule.read, rule.write ?? rule.read])
          if (!known(cap))
            problems.push(`${spec.name}: field policy on "${field}": "${cap}" is not a capability`);
    }
    if (problems.length) throw new Error(`Field policy:\n- ${problems.join('\n- ')}`);
  }
}
