import { DEFAULT_MAX_FILES, type FileFieldPolicy, fileFieldsOf } from '@hykr/contracts';
import type { AnyEntityDef } from '@hykr/core';
import { getTableColumns } from 'drizzle-orm';

/** A schema's fields, when it is an object (refinements keep the shape in Zod 4). */
const shapeOf = (schema: unknown): Record<string, unknown> | undefined =>
  (schema as { shape?: Record<string, unknown> } | undefined)?.shape;

/**
 * Mistakes in an entity's `files` trait, which stop the start: each field must be in the read
 * schema (so a reader sees which files it holds), writable (in the create or the update schema),
 * and a column of the table under the same key, with a sane count and size.
 */
export function fileFieldProblems(def: AnyEntityDef): string[] {
  const problems: string[] = [];
  const read = shapeOf(def.spec.schemas.read);
  const create = shapeOf(def.spec.schemas.create);
  const update = shapeOf(def.spec.schemas.update);
  const columns = getTableColumns(def.table) as Record<string, unknown>;
  for (const [field, policy] of fileFieldsOf(def.spec)) {
    const at = `${def.name}.${field}`;
    if (!read || !(field in read)) problems.push(`${at}: not in the read schema`);
    if (!(create && field in create) && !(update && field in update))
      problems.push(`${at}: in neither the create nor the update schema`);
    if (!(field in columns)) problems.push(`${at}: the table has no column with this key`);
    if (policy.max !== undefined && !(Number.isInteger(policy.max) && policy.max > 0))
      problems.push(`${at}: max must be a positive whole number`);
    if (
      policy.maxBytes !== undefined &&
      !(Number.isInteger(policy.maxBytes) && policy.maxBytes > 0)
    )
      problems.push(`${at}: maxBytes must be a positive whole number`);
  }
  return problems;
}

/** One file field of a served entity, or undefined when it declares none of that name. */
export function fileFieldOf(def: AnyEntityDef, field: string): FileFieldPolicy | undefined {
  return Object.hasOwn(def.spec.traits?.files ?? {}, field)
    ? def.spec.traits?.files?.[field]
    : undefined;
}

/** The most files a field holds: its `max`, else the default. */
export const maxFilesOf = (policy: FileFieldPolicy) => policy.max ?? DEFAULT_MAX_FILES;

/** The largest file a field takes: its own cap, within the deployment's. */
export const maxBytesOf = (policy: FileFieldPolicy, deployment: number) =>
  Math.min(policy.maxBytes ?? deployment, deployment);
