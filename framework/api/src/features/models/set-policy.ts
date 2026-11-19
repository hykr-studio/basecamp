// Setting a business's model policy, as a write: through runWrite, so it is validated, idempotent,
// authorized, audited (the policy before and after), parkable by a write hook and replayable
// from an approval.
import { modelRegistry, policyProblems } from '@hykr/agents';
import {
  atLeast,
  type ModelPolicy,
  ModelPolicyFields,
  ModelsCapability,
  type Principal,
} from '@hykr/contracts';
import { allow, deny, type NamedEvent, type WriteOp } from '@hykr/core';
import { schema } from '@hykr/db';
import { can } from '@hykr/policy';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

const { tenants } = schema;

/** The operation's name, as audited and as parked. */
export const SET_MODEL_POLICY = 'models.policy.set';

/** The policy as `PUT /api/models/policy` takes it: every field, unknown keys refused. */
export const ModelPolicyInput = ModelPolicyFields.strict();

/**
 * models.policy.changed: a business's model policy changed (stored in the outbox like any named
 * event). This process forgets its cached settings on it; others when their copy expires.
 */
export class ModelPolicyChanged implements NamedEvent {
  readonly eventName = 'models.policy.changed';
  readonly resourceType = 'tenant';
  readonly row: { id: string; models: ModelPolicy };
  constructor(
    readonly tenantId: string,
    models: ModelPolicy,
  ) {
    this.row = { id: tenantId, models };
  }
  get resourceId() {
    return this.tenantId;
  }
}

type Loaded = { tenantId: string; before: unknown };

const listed = (refs: readonly string[]) => (refs.length ? refs.join(', ') : 'the defaults only');

/** What the approval card and the audit say. */
function summary(policy: ModelPolicy) {
  const parts = [`Allow ${listed(policy.allowed)}`];
  if (policy.chat) parts.push(`chat on ${policy.chat}`);
  if (policy.embedding) parts.push(`embeddings on ${policy.embedding}`);
  if (policy.regions.length) parts.push(`only in ${policy.regions.join(', ')}`);
  return `Model policy: ${parts.join('; ')}`;
}

/**
 * Who may set it: a person (never the assistant or a background job), signed in, with
 * `models.manage` (owners and admins by default).
 */
function authorize(p: Principal) {
  if (p.actor.kind !== 'user')
    return deny('people_only', 'Only a person can change the model policy');
  if (!can(p, ModelsCapability))
    return deny(
      'models_manage',
      "Only people who choose the assistant's models can change the model policy",
    );
  if (!atLeast(p.assurance, 'session'))
    return deny('needs_assurance', 'Change the model policy in the app, signed in');
  return allow('models_manage', 'May choose the models');
}

/** The write itself. One per call: runWrite and an approval's replay each build theirs. */
export const setModelPolicy = (): WriteOp<ModelPolicy, Loaded, ModelPolicy> => ({
  name: SET_MODEL_POLICY,
  kind: 'command',
  resourceType: 'tenant',
  resourceId: (_input, loaded) => loaded.tenantId,
  input: ModelPolicyInput,
  // The business's row, locked: two changes at once apply one after the other.
  load: async (tx, p) => {
    const [row] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, p.tenantId ?? ''))
      .for('update');
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such business' });
    const stored = row.settings as Record<string, unknown> | null;
    return { tenantId: p.tenantId as string, before: stored?.models ?? null };
  },
  authorize,
  summarize: summary,
  run: async ({ tx, input, loaded }) => {
    // Checked when it was asked for; checked again here, for an approval replayed after the
    // deployment's models changed.
    const problems = policyProblems(modelRegistry(), input);
    if (problems.length) throw new ConflictException({ error: 'invalid_policy', problems });
    // Only the `models` key: the other sections stay as they are.
    await tx
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{models}', ${JSON.stringify(input)}::jsonb)`,
      })
      .where(eq(tenants.id, loaded.tenantId));
    return {
      value: input,
      touched: [
        {
          type: 'tenant',
          id: loaded.tenantId,
          change: 'updated',
          before: { models: loaded.before },
          after: { models: input },
        },
      ],
      events: [new ModelPolicyChanged(loaded.tenantId, input)],
    };
  },
  present: (value) => value,
});
