// A spec's references (`traits.references`, V2): each id a write sets or changes names a record
// the writer can read in their business, or the write is refused, the same way whether the id is
// unknown, another business's, or one the writer cannot read. docs/decisions/V2.md.
import { type EntitySpec, type Principal, referencesOf } from '@hykr/contracts';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Conn } from '../tokens.js';
import { entityDef } from './registry.js';

type Values = Record<string, unknown>;

/**
 * Load every reference this write sets to a value, or changes, through the target entity's own
 * scoped repository, as the writer (their business, the target's read access and its plugins'
 * scopes). Null always passes (an unlink), and so does an update that keeps the stored id.
 * Throws 404 `{ error: 'not_found', message: 'No such <target>', field }`.
 */
export async function checkReferences(
  conn: Conn,
  p: Principal,
  spec: EntitySpec,
  row: Values | null,
  input: Values,
): Promise<void> {
  for (const [field, entity] of referencesOf(spec)) {
    const id = input[field];
    if (id === undefined || id === null) continue;
    if (row && row[field] === id) continue;
    const target = entityDef(entity);
    // createCatalog refuses an unknown target at boot; an entity no module serves is a bug.
    if (!target) throw new Error(`${spec.name}.${field} names ${entity}, which is not served`);
    const found = typeof id === 'string' ? await target.repo.find(conn, p, id) : undefined;
    if (!found)
      throw new NotFoundException({
        error: 'not_found',
        message: `No such ${target.spec.label}`,
        field,
      });
  }
}

/** The code of a Postgres error, also through drizzle's wrapper. */
const pgCode = (e: unknown): string | undefined => {
  const code =
    (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === 'string' ? code : undefined;
};

/** Postgres refused a write because a key it names, or that names it, is missing (23503). */
export const isForeignKeyViolation = (e: unknown) => pgCode(e) === '23503';

/**
 * A foreign key the database refused, said without its detail (no constraint, column or value,
 * which could name another business's record): a write naming a record that is gone is 404, a
 * delete of a record others still name is 409 `in_use`. Anything else is returned as it is.
 */
export function referenceRefusal(
  e: unknown,
  action: 'write' | 'delete',
  label = 'record',
): unknown {
  if (!isForeignKeyViolation(e)) return e;
  if (action === 'delete')
    return new ConflictException({
      error: 'in_use',
      message: `Other records still name this ${label}`,
    });
  return new NotFoundException({
    error: 'not_found',
    message: 'It names a record that does not exist',
  });
}
