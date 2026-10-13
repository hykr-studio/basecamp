import { Pool } from 'pg';
import { openDatabase } from './database.js';
import { idempotencyRepo } from './repos/idempotency.js';
import { userExists } from './repos/users.js';

export function createDb(url: string) {
  const pool = new Pool({ connectionString: url });
  const db = openDatabase(pool);
  return {
    pool,
    db,
    idempotency: idempotencyRepo(db),
    userExists: (id: string) => userExists(db, id),
  };
}

export type { Database, DbOrTx } from './database.js';
export { frameworkMigrations, type MigrationSet, runMigrations } from './migrate.js';
export { type AuditInput, type WriteCtx, writeAudit } from './repos/audit.js';
export { idempotencyRepo } from './repos/idempotency.js';
export {
  type Contact,
  contactById,
  defaultOwnerOf,
  ensureDefaultTenant,
  type Membership,
  membershipOf,
} from './repos/tenancy.js';
export { userExists } from './repos/users.js';
// Builders for an application's own tables: the `app` schema and the id column.
export { app, id } from './schema/base.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
