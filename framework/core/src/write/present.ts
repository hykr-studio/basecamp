import type { Principal } from '@hykr/contracts';
import type { z } from 'zod';
import type { AnyEntityDef } from '../entity/define-entity.js';
import { toJson } from '../entity/define-entity.js';
import { entityDefForSchema } from '../entity/registry.js';
import { projectRead } from '../hooks.js';

type Values = Record<string, unknown>;
type Def = {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
};

const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
]);

const isPlain = (v: unknown): v is Values =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/**
 * Apply `atEntity` to every part of a value whose schema is a served entity's read schema:
 * at the top, inside objects and arrays, and through optional, nullable and default. Unions,
 * records and transforms are not entered (a command with such an output passes `present`).
 */
function walk(
  schema: z.ZodType,
  value: unknown,
  atEntity: (def: AnyEntityDef, record: Values) => unknown,
): unknown {
  const def = entityDefForSchema(schema);
  if (def && isPlain(value)) return atEntity(def, value);
  const d = (schema as unknown as { _zod: { def: Def } })._zod.def;
  if (WRAPPERS.has(d.type) && d.innerType)
    return value === null || value === undefined ? value : walk(d.innerType, value, atEntity);
  if (d.type === 'object' && d.shape && isPlain(value)) {
    const shape = d.shape;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shape[k] ? walk(shape[k], v, atEntity) : v]),
    );
  }
  if (d.type === 'array' && d.element && Array.isArray(value)) {
    const element = d.element;
    return value.map((v) => walk(element, v, atEntity));
  }
  return value;
}

/**
 * A command's result as this principal may see it. Each part that reuses an entity's read
 * schema is read as that entity (its plugins' toJson), the whole output is parsed, and each such
 * part is projected for p (fields hidden, never added). Then the read projectors run with
 * `resourceType` (the command's name).
 */
export function presentOutput(
  schema: z.ZodType,
  value: unknown,
  p: Principal,
  resourceType: string,
): unknown {
  const prepared = walk(schema, value, (def, record) => def.readJson(record));
  const parsed = schema.parse(toJson(prepared));
  const projected = walk(schema, parsed, (def, record) => def.project(record, p));
  return isPlain(projected) ? projectRead(resourceType, projected, p) : projected;
}
