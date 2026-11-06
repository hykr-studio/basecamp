// A business's model policy against the deployment's registry: which model a turn (or an
// embedding) uses, and whether a policy can be saved. Fails closed: anything not configured,
// not allowed or in the wrong region is refused, and nothing falls back to another model.
import type { ModelKind, ModelPolicy } from '@hykr/contracts';
import { FAKE_PROVIDER } from './config.js';
import type { ModelEntry, ModelRegistry } from './registry.js';

/** The model to use. */
export interface ModelChoice {
  ok: true;
  ref: string;
  entry: ModelEntry;
}

/** Why no model may run: a stable rule, a plain reason and the HTTP status the caller gets. */
export interface ModelRefusal {
  ok: false;
  rule: 'model_not_configured' | 'model_unknown' | 'model_not_allowed' | 'model_policy_invalid';
  reason: string;
  status: number;
}

const refuse = (rule: ModelRefusal['rule'], reason: string, status: number): ModelRefusal => ({
  ok: false,
  rule,
  reason,
  status,
});

/** The provider declares one of the business's regions (or the business names none). */
function inRegions(policy: ModelPolicy, m: ModelEntry) {
  if (!policy.regions.length) return true;
  return !!m.region && policy.regions.includes(m.region);
}

/**
 * May this business use this model? The in-process fake models always (nothing leaves the
 * process). Otherwise its provider must be in the business's regions, and the model must be in
 * `allowed`, or be the deployment's default of its kind when `allowed` is empty.
 */
export function allows(registry: ModelRegistry, policy: ModelPolicy, m: ModelEntry): boolean {
  if (m.provider === FAKE_PROVIDER) return true;
  if (!inRegions(policy, m)) return false;
  if (policy.allowed.length) return policy.allowed.includes(m.ref);
  return registry.defaults[m.kind] === m.ref;
}

/**
 * The model for one use: the one asked for (a turn hook's), else the business's own, else the
 * deployment's default. It must be registered as a model of that kind and allowed by the policy.
 */
export function chooseModel(
  registry: ModelRegistry,
  policy: ModelPolicy,
  use: { kind: ModelKind; requested?: string },
): ModelChoice | ModelRefusal {
  const { kind } = use;
  const own = kind === 'chat' ? policy.chat : policy.embedding;
  const fallback = registry.defaults[kind];
  const ref = use.requested || own || fallback;
  if (!ref)
    return refuse(
      'model_not_configured',
      `This deployment configures no ${kind} model (MODEL_PROVIDERS)`,
      503,
    );
  const entry = registry.get(ref);
  if (!entry || entry.kind !== kind) {
    // The deployment's own default is missing: a configuration error, not the business's.
    if (ref === fallback && !use.requested && !own)
      return refuse(
        'model_not_configured',
        `The default ${kind} model ${ref} is not configured (MODEL_PROVIDERS)`,
        503,
      );
    return refuse('model_unknown', `${ref} is not a ${kind} model of this deployment`, 503);
  }
  if (!allows(registry, policy, entry))
    return refuse(
      'model_not_allowed',
      inRegions(policy, entry)
        ? `This business does not allow the model ${ref}`
        : `The model ${ref} runs outside this business's regions`,
      403,
    );
  return { ok: true, ref, entry };
}

/**
 * What is wrong with a policy before it is saved, as plain sentences: models the deployment
 * does not have, allowed models outside the regions, a chat or embedding model it names that is
 * of the wrong kind or not allowed, and a policy that would refuse every turn (no chat model of
 * its own, and the deployment's default not allowed). An embedding model it does not name is not
 * checked: without one allowed, embeddings are refused when asked for, and turns still run.
 */
export function policyProblems(registry: ModelRegistry, policy: ModelPolicy): string[] {
  const problems: string[] = [];
  for (const ref of policy.allowed) {
    const m = registry.get(ref);
    if (!m) problems.push(`allowed: ${ref} is not a model of this deployment`);
    else if (!inRegions(policy, m))
      problems.push(`allowed: ${ref} runs outside the regions ${policy.regions.join(', ')}`);
  }
  for (const kind of ['chat', 'embedding'] as const) {
    if (kind === 'embedding' && !policy.embedding) continue;
    const choice = chooseModel(registry, policy, { kind });
    if (choice.ok) continue;
    problems.push(`${kind}${policy[kind] ? '' : " (the deployment's default)"}: ${choice.reason}`);
  }
  return [...new Set(problems)];
}
