// A spec's references (`traits.references`, V2): each id a write sets or changes names a record
// the writer can read in their business, or the write is refused, the same way whether the id is
// unknown, another business's, or one the writer cannot read. docs/decisions/V2.md.
import { type EntitySpec, type Principal, referencesOf } from '@hykr/contracts';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Conn } from '../tokens.js';
import { entityDef } from './registry.js';

type Values = Record<string, unknown>;
const log = new Logger('references');

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
  // The server's log keeps which key it was; the answer does not.
  const constraint =
    (e as { constraint?: unknown })?.constraint ??
    (e as { cause?: { constraint?: unknown } })?.cause?.constraint;
  log.warn(`a ${action} refused by the foreign key ${String(constraint ?? '(unnamed)')}`);
  if (action === 'delete')
    return new ConflictException({
      error: 'in_use',
      message: `Other records still name this ${label}`,
    });
  return new NotFoundException({ error: 'not_found', message: MISSING });
}

const MISSING = 'It names a record that does not exist';

/**
 * A write refused for a record it names (a declared reference's 404, with its field, or the
 * database's key's, without one), so a caller that reports it (an import) says both alike.
 */
export function refusedReference(e: unknown): { field: string | null; message: string } | null {
  if (!(e instanceof NotFoundException)) return null;
  const body = e.getResponse() as { error?: unknown; message?: unknown; field?: unknown };
  if (typeof body?.field === 'string' && typeof body.message === 'string')
    return { field: body.field, message: body.message };
  return body?.message === MISSING ? { field: null, message: MISSING } : null;
}
