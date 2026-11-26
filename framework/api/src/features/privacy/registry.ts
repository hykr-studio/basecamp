// What the application declares about personal data (B18): its processors, its policy for
// requests, its retention targets and their periods. Nothing here loads Nest: a module or the
// application declares these at load time. docs/decisions/B18.md.
import { createHookRegistry, type PrivacyRequestKind, RETENTION_NAME } from '@hykr/contracts';
import type { Tx } from '@hykr/core';
import type { Labels } from '@hykr/i18n';
import type { ErasedRecords } from '../../hooks.js';

declare module '@hykr/contracts' {
  interface Contributions {
    processors: readonly ProcessorDef[];
    privacyPolicies: readonly PrivacyPolicy[];
    retentionTargets: readonly RetentionTarget[];
    retentionPeriods: readonly RetentionPeriod[];
    recordCopies: readonly RecordCopies[];
    personalDataParts: readonly PersonalDataPart[];
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
  /**
   * Why data kept on erasure may stay, in the application's words, by keep reason (a trait's
   * `keepReason`, a part's): the register shows them. The framework names codes only.
   */
  keepReasons?: Readonly<Record<string, Labels>>;
}

/** A policy, checked: whole days, and words in English for each keep reason. */
export function definePrivacyPolicy(def: PrivacyPolicy): PrivacyPolicy {
  const days = def.respondWithinDays;
  if (days !== undefined && !(Number.isSafeInteger(days) && days >= 1 && days <= 365))
    throw new Error(`Privacy policy ${def.name}: respondWithinDays is 1 to 365 whole days`);
  for (const [code, words] of Object.entries(def.keepReasons ?? {}))
    if (!words?.en?.trim())
      throw new Error(`Privacy policy ${def.name}: say why "${code}" is kept`);
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

/* ── Copies and parts ─────────────────────────────────────────────────────── */

/**
 * A feature's own copies of records (a webhook body, a payload), redacted with the server's: when
 * records are erased or blanked, by an erasure or a retention rule, `redactCopies` hands each set
 * to every one of these after the audit, event and approval copies.
 */
export interface RecordCopies {
  /** Unique: 'integrations'. */
  name: string;
  /** Take these records' fields out of its copies in this business. Counts by where they are. */
  redact(a: { tx: Tx; tenantId: string; set: ErasedRecords }): Promise<Record<string, number>>;
}

export const recordCopies = createHookRegistry<RecordCopies>('record copies', (c) => c.name, {
  collects: 'recordCopies',
});

/**
 * Personal data a framework feature keeps outside the declared entities (its own tables), and
 * what erasure does to it: listed on the register beside the entities'.
 */
export interface PersonalDataPart {
  /** Unique, owner-prefixed: 'calendar.invites'. */
  name: string;
  label: Labels;
  /** What it holds about the person, by column. */
  fields: readonly string[];
  erase: 'delete' | 'anonymise' | 'keep';
  /** Why it stays (`erase: 'keep'`): a code; the application's policy says it in words. */
  keepReason?: string;
}

/** A part, checked: a kept part says why. */
export function definePersonalDataPart(def: PersonalDataPart): PersonalDataPart {
  if (!RETENTION_NAME.test(def.name))
    throw new Error(`Personal data part "${def.name}": lower case words joined by "."`);
  if (def.erase === 'keep' && !def.keepReason)
    throw new Error(`Personal data part ${def.name}: erase 'keep' needs a keepReason`);
  return def;
}

export const personalDataParts = createHookRegistry<PersonalDataPart>(
  'personal data part',
  (p) => definePersonalDataPart(p).name,
  { collects: 'personalDataParts' },
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
