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

// Builders for an application's own tables: the `app` schema, the id column, file, money and
// version columns.
export { fileColumn, fileColumns } from './columns/files.js';
export { currencyColumn, minorUnits } from './columns/money.js';
export { revisionColumns, versionColumn } from './columns/versions.js';
export type { Database, DbOrTx } from './database.js';
export {
  frameworkMigrations,
  type MigrationSet,
  migrationSetsIn,
  runMigrations,
  sqlHookFiles,
} from './migrate.js';
export { tableRef } from './ref.js';
export { type AuditInput, type WriteCtx, writeAudit, writeAuditMany } from './repos/audit.js';
export { idempotencyRepo } from './repos/idempotency.js';
export { takeNumber } from './repos/numbering.js';
export {
  type Contact,
  contactById,
  defaultOwnerOf,
  ensureDefaultTenant,
  type Membership,
  membershipOf,
} from './repos/tenancy.js';
export { userExists } from './repos/users.js';
export { app, id } from './schema/base.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
