// Test files side by side: one database and one set of Redis keys per Vitest worker, so files
// that each boot the whole application never see each other's rows, queues or outbox.
//
// vitest.config.ts:  fileParallelism: workers > 1, maxWorkers: workers,
//                    globalSetup that calls workerDatabases(migrate),
//                    setupFiles with one line: `useWorker()`.
//
// With one worker (TEST_WORKERS=1) nothing changes: the tests use DATABASE_URL itself.
// This file imports only pg and Node: a setup file loads it before anything reads the environment.
import { availableParallelism } from 'node:os';
import pg from 'pg';

type Env = Record<string, string | undefined>;

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/app';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
/** Redis has 16 databases unless configured otherwise; database 0 stays the developer's. */
const REDIS_DATABASES = 16;

/**
 * How many test files run at once: TEST_WORKERS, else one per processor up to four (each file
 * boots an API with its own pools; past four the database is the limit, not the processors).
 */
export function workerCount(env: Env = process.env): number {
  const asked = Number(env.TEST_WORKERS);
  const count = env.TEST_WORKERS && Number.isInteger(asked) ? asked : availableParallelism();
  return Math.max(1, Math.min(count, env.TEST_WORKERS ? REDIS_DATABASES - 1 : 4));
}

/** A database URL with another database name; the rest (host, role, parameters) is kept. */
function withDatabase(url: string, name: (base: string) => string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name(decodeURIComponent(parsed.pathname.slice(1)) || 'app')}`;
  return parsed.toString();
}

/** The database of worker `id` (1-based): `<database>_test_<id>` beside DATABASE_URL's. */
export function workerDatabaseUrl(id: number, url = DEFAULT_DATABASE_URL): string {
  return withDatabase(url, (base) => `${base}_test_${id}`);
}

/**
 * What worker `id` (1-based) runs with instead of the shared values: its own database, its own
 * Redis database, and its own queue prefix (a worker relays only its own prefix's outbox rows).
 */
export function workerEnv(id: number, env: Env = process.env): Record<string, string> {
  const database = workerDatabaseUrl(id, env.DATABASE_URL);
  const redis = new URL(env.REDIS_URL ?? DEFAULT_REDIS_URL);
  redis.pathname = `/${id % REDIS_DATABASES}`;
  return {
    DATABASE_URL: database,
    MIGRATE_DATABASE_URL: env.MIGRATE_DATABASE_URL
      ? workerDatabaseUrl(id, env.MIGRATE_DATABASE_URL)
      : database,
    REDIS_URL: redis.toString(),
    BULL_PREFIX: `${env.BULL_PREFIX ?? 'test'}-w${id}`,
  };
}

/**
 * In a setup file: point this worker at its own database and Redis keys. Vitest numbers its
 * workers from 1 (VITEST_POOL_ID); with one worker the shared values stay.
 */
export function useWorker(env: Env = process.env): void {
  if (workerCount(env) === 1) return;
  const id = Number(env.VITEST_POOL_ID ?? 1);
  // The base values, kept so a worker reused for another file derives the same ones again.
  env.TEST_BASE_ENV ??= JSON.stringify({
    DATABASE_URL: env.DATABASE_URL,
    MIGRATE_DATABASE_URL: env.MIGRATE_DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    BULL_PREFIX: env.BULL_PREFIX,
  });
  Object.assign(env, workerEnv(id, { ...env, ...(JSON.parse(env.TEST_BASE_ENV) as Env) }));
}

/**
 * In globalSetup: make each worker's database (kept between runs, like the shared one) and
 * migrate it with `migrate`, which gets the database's URL. The role must be allowed to create
 * databases and extensions, as Compose's and CI's `app` role is. With one worker, the shared
 * database is migrated and nothing is created.
 */
export async function workerDatabases(
  migrate: (url: string) => Promise<void>,
  env: Env = process.env,
): Promise<void> {
  const count = workerCount(env);
  const base = env.MIGRATE_DATABASE_URL ?? env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  if (count === 1) return migrate(base);

  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    for (let id = 1; id <= count; id++) {
      const name = new URL(workerDatabaseUrl(id, base)).pathname.slice(1);
      const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [
        decodeURIComponent(name),
      ]);
      if (!rowCount) await admin.query(`create database "${decodeURIComponent(name)}"`);
    }
  } finally {
    await admin.end();
  }
  for (let id = 1; id <= count; id++) {
    const url = workerDatabaseUrl(id, base);
    // What Compose's init.sql gives the shared database (the role's search_path is the role's).
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('create extension if not exists postgis');
      await client.query('create extension if not exists pgcrypto');
    } finally {
      await client.end();
    }
    await migrate(url);
  }
}
