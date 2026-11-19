import type { EntitySpec } from './spec.js';

/** The record a memory is about: a project, a meeting. */
export interface MemoryAbout {
  type: string;
  id: string;
}

/**
 * The records of this entity are memory the assistant recalls by meaning (semantic recall).
 * The entity's own access decides who recalls them: recall loads each record again as the person
 * whose turn it is, and builds `text` from the record as that person may see it (hidden fields
 * are already gone), so a record they cannot read is never recalled.
 *
 *   traits: { memory: { text: (n) => `${n.title}: ${n.body}`, about: (n) => n.meetingId
 *     ? { type: 'meeting', id: n.meetingId } : null } }
 */
// biome-ignore lint/suspicious/noExplicitAny: a record in its read shape
export interface MemoryTrait<R = any> {
  /** The words recall searches and shows. Empty: the record is not memory (nothing is kept). */
  text(record: R): string;
  /**
   * The record this one is memory of. Recall shows it with the memory, finds memory by it (the
   * recall API's `about`), and drops the memory for anyone who cannot read that record.
   */
  about?(record: R): MemoryAbout | null | undefined;
}

declare module './traits.js' {
  interface EntityTraits {
    memory?: MemoryTrait;
  }
}

/** The entity's memory trait, if its records are memory. */
export const memoryTraitOf = (spec: EntitySpec): MemoryTrait | undefined => spec.traits?.memory;
