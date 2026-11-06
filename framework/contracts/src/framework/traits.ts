/**
 * Behaviour an entity or command opts into by declaration: money fields, versions, a parent,
 * states, a public view. Open: each feature declares its trait, optional, in its own file
 * (`contracts/src/framework/<feature>.ts`), and its plugin acts on specs that carry it:
 *
 *   declare module '@hykr/contracts' {
 *     interface EntityTraits { versioned?: { frozenWhen?: string[] } }
 *   }
 *
 * Specs carry them as `traits` (see spec.ts).
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface EntityTraits {}

/** A command's traits, declared the same way as `EntityTraits`. */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface CommandTraits {}
