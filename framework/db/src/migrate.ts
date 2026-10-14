import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/** One folder of migrations and the table that records which of them ran. */
export type MigrationSet = { folder: string; table: string };

/** The framework's own migrations, shipped with this package. */
export const frameworkMigrations: MigrationSet = {
  folder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  table: '__framework_migrations',
};

/**
 * Apply the framework's migrations, then the application's, each recorded in its own table
 * in the `drizzle` schema: the framework's tables (tenancy, approvals, channels) come first,
 * because the application's reference them.
 */
export async function runMigrations(url: string, application: MigrationSet[] = []) {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool);
    for (const set of [frameworkMigrations, ...application])
      await migrate(db, {
        migrationsFolder: set.folder,
        migrationsSchema: 'drizzle',
        migrationsTable: set.table,
      });
  } finally {
    await pool.end();
  }
}
