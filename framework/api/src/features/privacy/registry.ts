// What the application declares about personal data (B18): its processors, its policy for
// requests, its retention targets and their periods. Nothing here loads Nest: a module or the
// application declares these at load time. docs/decisions/B18.md.
import { createHookRegistry, type PrivacyRequestKind, RETENTION_NAME } from '@hykr/contracts';
import type { Tx } from '@hykr/core';
import type { Labels } from '@hykr/i18n';

declare module '@hykr/contracts' {
  interface Contributions {
    processors: readonly ProcessorDef[];
    privacyPolicies: readonly PrivacyPolicy[];
    retentionTargets: readonly RetentionTarget[];
    retentionPeriods: readonly RetentionPeriod[];
  }
}

/* ── Processors ───────────────────────────────────────────────────────────── */

/**
 * A service that processes personal data for every business of this application (the model
 * gateway, the messaging provider, email): listed on each business's register. The application
 * declares them; a business adds its own in its `privacy` settings.
 */
export interface ProcessorDef {
  /** Unique: what the business would call it. */
  name: string;
  /** What it does with the data, in every language. */
  purpose: Labels;
  /** The kinds of personal data it gets. */
  data?: readonly string[];
  /** Where it keeps the data. */
  location?: string;
  url?: string;
}

/** A processor, checked: a name and a purpose. */
export function defineProcessor(def: ProcessorDef): ProcessorDef {
  if (!def.name?.trim()) throw new Error('A processor needs a name');
  if (!def.purpose?.en?.trim()) throw new Error(`Processor ${def.name}: say its purpose`);
  return def;
}

export const processors = createHookRegistry<ProcessorDef>(
  'processor',
  (p) => defineProcessor(p).name,
  { collects: 'processors' },
);

/* ── The policy for requests ──────────────────────────────────────────────── */

/**
 * How this application answers requests about personal data, unless a business says otherwise
 * in its `privacy` settings: the deadline, and the kinds of a person's own request that wait for
 * review. At most one per application.
 */
export interface PrivacyPolicy {
  /** Unique: 'app'. */
  name: string;
  /** Answer within this many days of receiving a request. Unset: no deadline. */
  respondWithinDays?: number;
  /** A person's own requests of these kinds wait for someone with `privacy.manage`. */
  review?: readonly PrivacyRequestKind[];
}

/** A policy, checked: whole days. */
export function definePrivacyPolicy(def: PrivacyPolicy): PrivacyPolicy {
  const days = def.respondWithinDays;
  if (days !== undefined && !(Number.isSafeInteger(days) && days >= 1 && days <= 365))
    throw new Error(`Privacy policy ${def.name}: respondWithinDays is 1 to 365 whole days`);
  return def;
}

export const privacyPolicies = createHookRegistry<PrivacyPolicy>(
  'privacy policy',
  (p) => definePrivacyPolicy(p).name,
  { collects: 'privacyPolicies' },
);

/** The application's policy: its one declaration, or none. */
export const privacyPolicy = (): PrivacyPolicy | undefined => privacyPolicies.all()[0];

/* ── Retention ────────────────────────────────────────────────────────────── */

/** Records a target or an erasure changed, whose copies (audit, events) lose these fields. */
export interface ErasedRecords {
  /** The resource type audit and events name them by: the entity's name. */
  type: string;
  ids: readonly string[];
  /** The fields to take out of their copies. */
  fields: readonly string[];
  /** The records are gone (all their files go), not only blanked. */
  deleted?: boolean;
}

/**
 * Data that goes after a period: a framework table (raw payloads, conversation messages), an
 * application's own table, or an entity's records (its `privacy` trait's retention rule, added
 * by the privacy feature). The period is not the target's: the application gives it
 * (`retentionPeriods`, or the trait's `days`) and a business overrides it; a target with no
 * period never runs.
 */
export interface RetentionTarget {
  /** Unique, owner-prefixed: 'channel.inbound-payloads'. The periods name it. */
  name: string;
  /** What it clears, for the register. */
  label: Labels;
  /**
   * 'tenant': it runs once per business, and the business may change its period. 'deployment':
   * once for the whole deployment (data that names no business), with the application's period.
   */
  scope: 'tenant' | 'deployment';
  /** What happens to the data: 'delete', 'anonymise' or 'empty' (a payload cleared). */
  action: string;
  /** The period the target's owner gives, in days, when the application gives none. */
  days?: number;
  /**
   * Clear what is older than `before`, in this business (none for a deployment target), in the
   * runner's transaction. Returns how many rows it changed, and the records whose copies the
   * runner redacts.
   */
  apply(a: {
    tenantId?: string;
    before: Date;
    tx: Tx;
  }): Promise<{ count: number; erased?: readonly ErasedRecords[] }>;
}

export const retentionTargets = createHookRegistry<RetentionTarget>(
  'retention target',
  (t) => t.name,
  { collects: 'retentionTargets' },
);

/** The application's period for a target, in whole days. */
export interface RetentionPeriod {
  /** The target's name: 'channel.inbound-payloads'. */
  target: string;
  days: number;
}

export const retentionPeriods = createHookRegistry<RetentionPeriod>(
  'retention period',
  (p) => p.target,
  { collects: 'retentionPeriods' },
);

/**
 * What is wrong with the declarations: more than one policy, a target or period with a bad name
 * or period, a period for no target.
 */
export function registryProblems(): string[] {
  const problems: string[] = [];
  const policies = privacyPolicies.all();
  if (policies.length > 1)
    problems.push(
      `Only one privacy policy may be contributed; found ${policies.map((p) => p.name).join(', ')}`,
    );
  const days = (d: unknown) => Number.isSafeInteger(d) && (d as number) >= 1;
  for (const t of retentionTargets.all()) {
    if (!RETENTION_NAME.test(t.name))
      problems.push(`Retention target "${t.name}": lower case words joined by "."`);
    if (t.days !== undefined && !days(t.days))
      problems.push(`Retention target ${t.name}: days must be whole days, at least 1`);
    if (typeof t.apply !== 'function') problems.push(`Retention target ${t.name}: give apply()`);
  }
  for (const p of retentionPeriods.all()) {
    if (!retentionTargets.has(p.target))
      problems.push(`Retention period for "${p.target}": no retention target has that name`);
    if (!days(p.days))
      problems.push(`Retention period for ${p.target}: days must be whole days, at least 1`);
  }
  return problems;
}
