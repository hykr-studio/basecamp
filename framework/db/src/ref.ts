import { type PgSchema, text } from 'drizzle-orm/pg-core';
import { app } from './schema/base.js';

/**
 * Another module's table, by name only, for a foreign key from a module that must not import it
 * (a module lower in the dependency graph naming a record of one that depends on it). Its module
 * owns and migrates the real table; this one is never exported from a schema file, so
 * drizzle-kit sees only the reference. Not for queries. It has `id` and `tenantId`, so the key
 * can keep a reference in its own business: `foreignKey({ columns: [t.tenantId, t.xId],
 * foreignColumns: [ref.tenantId, ref.id] })`, with a unique (tenant_id, id) on the target. A
 * SET NULL of the reference column alone needs a SQL hook (`ON DELETE SET NULL (x_id)`).
 * Declare the reference on the spec too (`traits.references`): docs/decisions/V2.md.
 */
export const tableRef = (name: string, schema: PgSchema = app) =>
  schema.table(name, { id: text('id').notNull(), tenantId: text('tenant_id').notNull() });
