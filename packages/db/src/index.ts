import { Pool } from 'pg';
import { openDatabase } from './database.js';
import { idempotencyRepo } from './repos/idempotency.js';
import { todoRepo } from './repos/todos.js';
import { userExists } from './repos/users.js';

export function createDb(url: string) {
  const pool = new Pool({ connectionString: url });
  const db = openDatabase(pool);
  return {
    pool,
    db,
    todos: todoRepo(db),
    idempotency: idempotencyRepo(db),
    userExists: (id: string) => userExists(db, id),
  };
}

export * as schema from './schema/index.js';
export * from './schema/index.js';
export { writeAudit, type AuditInput, type WriteCtx } from './repos/audit.js';
export { idempotencyRepo } from './repos/idempotency.js';
export { todoRepo } from './repos/todos.js';
export { userExists } from './repos/users.js';
export type { Database, DbOrTx } from './database.js';
