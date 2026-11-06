import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';

/** One folder of migrations, the table that records which of them ran, and its SQL hooks. */
export type MigrationSet = {
  /** drizzle-kit's output folder (it holds `meta/_journal.json`). */
  folder: string;
  /** The table in the `drizzle` schema that records the applied migrations. */
  table: string;
  /**
   * The set's hooks: `<sql>/pre/*.sql` run before its migrations, `<sql>/post/*.sql` after,
   * on every migrate (see `runMigrations`). Defaults to the `sql` folder next to `folder`
   * (`framework/db/sql`, `application/domain/sql`). No folder, no hooks.
   */
  sql?: string;
};

/** The framework's own migrations (and hooks in `sql/`), shipped with this package. */
export const frameworkMigrations: MigrationSet = {
  folder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  table: '__framework_migrations',
};

/** Every migrate on a database takes this advisory lock, so two never interleave. */
const MIGRATE_LOCK = 7_302_046_210;

/** A set's hook files for one phase: `*.sql` in `<sql>/<phase>/`, in name order. */
export function sqlHookFiles(set: MigrationSet, phase: 'pre' | 'post'): string[] {
  const dir = join(set.sql ?? join(dirname(set.folder), 'sql'), phase);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => join(dir, file));
}

/**
 * One migration set per folder of `root` that holds `migrations/meta/_journal.json`, in name
 * order: `<root>/<name>/migrations`, recorded in `__<prefix>_<name>_migrations`, hooks in
 * `<root>/<name>/sql`. Parallel features each get their own journal, so they never conflict.
 * The framework's e2e fixture finds its per-feature sets this way.
 */
export function migrationSetsIn(root: string, prefix: string): MigrationSet[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, name, 'migrations', 'meta', '_journal.json')))
    .sort()
    .map((name) => {
      if (!/^[a-z][a-z0-9_-]*$/.test(name))
        throw new Error(
          `Migration set "${name}" in ${root}: name it with lower-case letters, digits, - and _`,
        );
      return {
        folder: join(root, name, 'migrations'),
        table: `__${prefix}_${name.replaceAll('-', '_')}_migrations`,
        sql: join(root, name, 'sql'),
      };
    });
}

type JournalEntry = { when: number; tag: string };

function journalOf(set: MigrationSet): JournalEntry[] {
  const path = join(set.folder, 'meta', '_journal.json');
  if (!existsSync(path)) throw new Error(`No migrations in ${set.folder}: ${path} is missing`);
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: JournalEntry[] }).entries;
}

/**
 * Migrations drizzle would skip without a word: never applied, yet older than the last one
 * applied (drizzle only applies entries newer than that). Matched by the timestamp drizzle
 * records, so an edited migration is not mistaken for a skipped one.
 */
async function skippedIn(client: PoolClient, set: MigrationSet): Promise<string[]> {
  const found = await client.query<{ t: string | null }>(
    `select to_regclass(format('%I.%I', 'drizzle', $1::text)) as t`,
    [set.table],
  );
  if (!found.rows[0]?.t) return [];
  const { rows } = await client.query<{ created_at: string }>(
    `select created_at from drizzle.${client.escapeIdentifier(set.table)}`,
  );
  const applied = new Set(rows.map((r) => Number(r.created_at)));
  if (!applied.size) return [];
  const last = Math.max(...applied);
  return journalOf(set)
    .filter((entry) => entry.when < last && !applied.has(entry.when))
    .map((entry) => entry.tag);
}

async function runHooks(client: PoolClient, set: MigrationSet, phase: 'pre' | 'post') {
  for (const file of sqlHookFiles(set, phase)) {
    try {
      // One file, one query: Postgres runs its statements in a single transaction.
      await client.query(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`SQL hook ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}

/**
 * Apply the framework's migrations, then the application's, each recorded in its own table
 * in the `drizzle` schema: the framework's tables (tenancy, approvals, channels) come first,
 * because the application's reference them.
 *
 * Each set runs its `sql/pre` hooks, then its migrations, then its `sql/post` hooks. Hooks are
 * for what drizzle-kit does not generate (extensions, triggers, CHECK constraints). They run
 * every time, so they must be idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF
 * EXISTS` then `CREATE`). The whole run holds an advisory lock, and it refuses to start when a
 * set has a migration drizzle would skip.
 */
export async function runMigrations(url: string, application: MigrationSet[] = []) {
  const sets = [frameworkMigrations, ...application];
  const tables = sets.map((set) => set.table);
  const twice = tables.find((table, i) => tables.indexOf(table) !== i);
  if (twice) throw new Error(`Two migration sets record into drizzle.${twice}`);

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    // One connection for everything: the advisory lock belongs to the session that took it.
    const client = await pool.connect();
    try {
      await client.query('select pg_advisory_lock($1)', [MIGRATE_LOCK]);
      try {
        for (const set of sets) {
          const skipped = await skippedIn(client, set);
          if (skipped.length)
            throw new Error(
              `${set.folder} has migrations older than the last one applied to this database, ` +
                `which drizzle would skip: ${skipped.join(', ')}. Regenerate them so they come ` +
                'last (drop them and run generate again), or recreate the database.',
            );
        }
        const db = drizzle(client);
        for (const set of sets) {
          await runHooks(client, set, 'pre');
          await migrate(db, {
            migrationsFolder: set.folder,
            migrationsSchema: 'drizzle',
            migrationsTable: set.table,
          });
          await runHooks(client, set, 'post');
        }
      } finally {
        await client.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK]).catch(() => {});
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
