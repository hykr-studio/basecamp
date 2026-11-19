// References (V2, R1): a field that holds another record's id. A spec declares them, naming the
// target entity by name, so a reference down the module graph imports nothing. The server loads
// each id a write sets or changes through the target's own scoped repository, as the writer: an
// unknown id, another business's id and a record the writer cannot read get the same 404. A
// record with a parent (a line item) declares them too: its tree writes check every new line's
// ids in bulk, one query per target. docs/decisions/V2.md, docs/decisions/R1.md.
import type { EntitySpec } from './spec.js';

/** One declared reference: the target entity's name, or the name and a field read as its label. */
export type ReferenceDecl = string | { entity: string; label?: string };

declare module './traits.js' {
  interface EntityTraits {
    /**
     * Fields holding another record's id, and the entity each names: `{ meetingId: 'meeting' }`,
     * or `{ productId: { entity: 'product', label: 'name' } }` to read the target's `name` with
     * each record (`references: { productId: { id, label } }` on lists and gets). Every insert
     * and update that sets or changes one is refused (404 `not_found`, with the field) unless
     * the writer can read that record in their business. A record with a parent is checked in
     * bulk by its tree writes (`children.insert`, `children.replace`), with the line's `path`.
     */
    references?: Readonly<Record<string, ReferenceDecl>>;
  }
}

/** What a read carries for its labelled references: `{ productId: { id, label } }`. */
export type ReferenceLabels = Record<string, { id: string; label: string | null }>;

const entityOf = (d: ReferenceDecl) => (typeof d === 'string' ? d : d.entity);

/** A spec's references, as [field, target entity] pairs. */
export const referencesOf = (spec: EntitySpec): [field: string, entity: string][] =>
  Object.entries(spec.traits?.references ?? {}).map(([field, d]) => [field, entityOf(d)]);

/** A spec's references that read a label, as [field, target entity, label field]. */
export const referenceLabelsOf = (
  spec: EntitySpec,
): [field: string, entity: string, label: string][] =>
  Object.entries(spec.traits?.references ?? {}).flatMap(([field, d]) =>
    typeof d !== 'string' && d.label
      ? [[field, d.entity, d.label] as [string, string, string]]
      : [],
  );

const shapeOf = (s: unknown) => (s as { shape?: Record<string, unknown> }).shape ?? {};

/**
 * What is wrong with a spec's references, given the catalog's entities by name: a target that is
 * not one of them, a field no write schema has, a label its target's read schema has not.
 * Empty: nothing.
 */
export function referenceProblems(
  spec: EntitySpec,
  entities: ReadonlyMap<string, EntitySpec>,
): string[] {
  const writable = { ...shapeOf(spec.schemas.create), ...shapeOf(spec.schemas.update) };
  const problems: string[] = [];
  for (const [field, d] of Object.entries(spec.traits?.references ?? {})) {
    const entity = entityOf(d);
    const target = entities.get(entity);
    if (!target)
      problems.push(`${spec.name}: the reference ${field} names ${entity}, which is not an entity`);
    if (!(field in writable))
      problems.push(`${spec.name}: the reference ${field} is not a field it creates or updates`);
    const label = typeof d === 'string' ? undefined : d.label;
    if (target && label !== undefined && !(label in shapeOf(target.schemas.read)))
      problems.push(
        `${spec.name}: the reference ${field} reads ${entity}.${label}, which ${entity} has not`,
      );
  }
  return problems;
}
