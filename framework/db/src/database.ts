import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema/index.js';

export function openDatabase(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof openDatabase>;

/** A connection or a transaction. Both can read and write. */
export type DbOrTx = Pick<Database, 'insert' | 'select' | 'update' | 'delete'>;
