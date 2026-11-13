// References (V2): a field that holds another record's id. A spec declares them, naming the target
// entity by name, so a reference down the module graph imports nothing. The server loads each id
// a write sets or changes through the target's own scoped repository, as the writer: an unknown
// id, another business's id and a record the writer cannot read get the same 404.
// docs/decisions/V2.md.
import type { EntitySpec } from './spec.js';

declare module './traits.js' {
  interface EntityTraits {
    /**
     * Fields holding another record's id, and the entity each names: `{ meetingId: 'meeting' }`.
     * Every insert and update that sets or changes one is refused (404 `not_found`, with the
     * field) unless the writer can read that record in their business. Not for a record with a
     * parent: its children are saved in bulk, through the parent.
     */
    references?: Readonly<Record<string, string>>;
  }
}

/** A spec's references, as [field, target entity] pairs. */
export const referencesOf = (spec: EntitySpec): [field: string, entity: string][] =>
  Object.entries(spec.traits?.references ?? {});

/**
 * What is wrong with a spec's references, given the names of the catalog's entities: a target
 * that is not one of them, a field no write schema has, a reference on a child. Empty: nothing.
 */
export function referenceProblems(spec: EntitySpec, entities: ReadonlySet<string>): string[] {
  const refs = referencesOf(spec);
  if (!refs.length) return [];
  if (spec.traits?.parent)
    return [
      `${spec.name}: a record with a parent cannot declare references (its children are saved in bulk, unchecked)`,
    ];
  const shape = (s: unknown) => (s as { shape?: Record<string, unknown> }).shape ?? {};
  const writable = { ...shape(spec.schemas.create), ...shape(spec.schemas.update) };
  const problems: string[] = [];
  for (const [field, entity] of refs) {
    if (!entities.has(entity))
      problems.push(`${spec.name}: the reference ${field} names ${entity}, which is not an entity`);
    if (!(field in writable))
      problems.push(`${spec.name}: the reference ${field} is not a field it creates or updates`);
  }
  return problems;
}
