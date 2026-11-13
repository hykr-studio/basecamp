// Personal data (B18): which records hold someone's personal data, which fields, what forgetting
// them does, and how long the business keeps them. A module declares it on the spec
// (`traits.privacy`); the privacy feature in @hykr/api exports, erases and expires records by it.
// No period, reason or purpose is the framework's: each is the module's, and a business overrides
// the periods in its `privacy` settings. docs/decisions/B18.md.
import type { Labels } from '@hykr/i18n';
import type { EntitySpec } from './spec.js';

/** What forgetting a person does to a record of theirs. */
export type PrivacyErase =
  /** The record goes. */
  | 'delete'
  /** The record stays; its personal fields are blanked (`replace`, else null). */
  | 'anonymise'
  /** The record stays as it is, for the reason the module names (`keepReason`): a legal hold. */
  | 'keep';

/** How long the personal data of a record is kept, and what happens then. */
export interface PrivacyRetention {
  /**
   * Unique in the application, owner-prefixed: 'notes.personal'. A business overrides the period
   * by this name (settings `privacy.retention`).
   */
  name: string;
  /** Whole days after `from`. */
  days: number;
  /** The date column (by its key in the table) the days count from. Default 'createdAt'. */
  from?: string;
  /** Delete the record, or blank its personal fields. */
  action: 'delete' | 'anonymise';
}

/**
 * The records of this entity hold someone's personal data.
 *
 *   traits: { privacy: { subject: { customer: ['customerId'] }, fields: ['title', 'body'],
 *     erase: 'delete', retention: { name: 'notes.personal', days: 730, action: 'delete' } } }
 */
export interface PrivacyTrait {
  /**
   * Whose personal data a record is: the table's columns (by key) that hold a person's user id
   * (`user`), their customer record's id (`customer`) or a WhatsApp contact's id (`contact`). A
   * record is someone's when one of these holds one of their ids. Name at least one. A record's
   * owner is often a member of the team, whose records are the business's: say `user` only for
   * records that are about the person themselves.
   */
  subject: {
    user?: readonly string[];
    customer?: readonly string[];
    contact?: readonly string[];
  };
  /**
   * The fields (the table's keys) that hold personal data: what a person's export carries, what
   * anonymising blanks and what audit redaction removes from the copies the server keeps.
   */
  fields: readonly string[];
  /** What forgetting the person does to their records. */
  erase: PrivacyErase;
  /** With `keep`: why, as a stable code ('legal_hold'), kept in the erasure's evidence. */
  keepReason?: string;
  /** What anonymising writes in each field. Default null; a NOT NULL column needs one. */
  replace?: Readonly<Record<string, unknown>>;
  /** When the personal data of the records goes. */
  retention?: PrivacyRetention;
  /** Why the business keeps these records, in every language: shown on its register. */
  purpose?: Labels;
}

declare module './traits.js' {
  interface EntityTraits {
    privacy?: PrivacyTrait;
  }
}

/** The entity's privacy trait, if its records are someone's personal data. */
export const privacyOf = (spec: Pick<EntitySpec, 'traits'>): PrivacyTrait | undefined =>
  spec.traits?.privacy;

/** Every subject column a trait names, of every kind. */
export const subjectColumnsOf = (trait: PrivacyTrait): string[] => [
  ...new Set([
    ...(trait.subject.user ?? []),
    ...(trait.subject.customer ?? []),
    ...(trait.subject.contact ?? []),
  ]),
];

/** A retention rule's name: lower case words joined by '.', '-' or '_'. */
export const RETENTION_NAME = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;

/**
 * What is wrong with a trait, before any table is known: no subject column, no field, `keep`
 * without a reason, a retention rule that is not whole days.
 */
export function privacyTraitProblems(entity: string, trait: PrivacyTrait): string[] {
  const problems: string[] = [];
  const at = `Entity ${entity}, trait privacy`;
  if (!subjectColumnsOf(trait).length)
    problems.push(`${at}: name at least one subject column (user, customer or contact)`);
  if (!trait.fields.length) problems.push(`${at}: name at least one personal field`);
  if (!['delete', 'anonymise', 'keep'].includes(trait.erase))
    problems.push(`${at}: erase must be 'delete', 'anonymise' or 'keep'`);
  if (trait.erase === 'keep' && !trait.keepReason)
    problems.push(`${at}: erase 'keep' needs a keepReason`);
  for (const key of Object.keys(trait.replace ?? {}))
    if (!trait.fields.includes(key))
      problems.push(`${at}: replace names "${key}", which is not one of its fields`);
  const r = trait.retention;
  if (r) {
    if (!RETENTION_NAME.test(r.name))
      problems.push(`${at}: retention name "${r.name}" must be lower case words joined by "."`);
    if (!Number.isSafeInteger(r.days) || r.days < 1)
      problems.push(`${at}: retention days must be a whole number of days, at least 1`);
    if (!['delete', 'anonymise'].includes(r.action))
      problems.push(`${at}: retention action must be 'delete' or 'anonymise'`);
  }
  return problems;
}
