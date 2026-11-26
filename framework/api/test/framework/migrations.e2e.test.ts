import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MigrationSet, runMigrations } from '@hykr/db';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { fixture } from '../fixture/dist/index.js';
import { featureMigrations } from '../fixture/dist/migrations.js';

// SQL hooks, per-feature migration sets, the migrate lock and the skip guard, against the
// tests' own database (DATABASE_URL from the .env: the same one globalSetup migrated).
const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const stamp = Date.now();
const tmp = mkdtempSync(join(tmpdir(), 'basecamp-migrate-'));
const drop: string[] = [];

afterAll(async () => {
  for (const table of drop) await db.query(`drop table if exists ${table}`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

type Migration = { tag: string; when: number; sql: string };

/** Write a set's migrations as drizzle-kit would: SQL files and meta/_journal.json. */
function writeMigrations(set: MigrationSet, migrations: Migration[]) {
  mkdirSync(join(set.folder, 'meta'), { recursive: true });
  const entries = migrations.map((m, idx) => ({
    idx,
    version: '7',
    when: m.when,
    tag: m.tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(set.folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  for (const m of migrations) writeFileSync(join(set.folder, `${m.tag}.sql`), m.sql);
}

/** A migration set in a temporary folder, with hooks if given. Dropped after the file. */
function tempSet(name: string, migrations: Migration[], pre: Record<string, string> = {}) {
  const set: MigrationSet = {
    folder: join(tmp, name, 'migrations'),
    table: `__test_${name}_migrations`,
  };
  writeMigrations(set, migrations);
  mkdirSync(join(tmp, name, 'sql', 'pre'), { recursive: true });
  for (const [file, sql] of Object.entries(pre))
    writeFileSync(join(tmp, name, 'sql', 'pre', file), sql);
  drop.push(`drizzle."${set.table}"`);
  return set;
}

const exists = async (table: string) =>
  (await db.query<{ t: string | null }>('select to_regclass($1) as t', [table])).rows[0].t !== null;

const count = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ n: number }>(sql, params)).rows[0].n;

describe('per-feature fixture migration sets', () => {
  it('globalSetup applied each feature set, in the database the tests use', async () => {
    const par = featureMigrations.find((set) => set.table === '__fixture_par_migrations');
    expect(par?.folder).toMatch(/src\/features\/par\/migrations$/);
    expect(await count('select count(*)::int as n from drizzle.__fixture_par_migrations')).toBe(1);
    expect(await exists('app.fixture_par_notes')).toBe(true);
  });

  it("ran the set's pre hook before its migration and its post hook after", async () => {
    // pre made the function, the migration the table, post the trigger and the CHECK.
    const title = `Order Tiles ${stamp}`;
    const { rows } = await db.query<{ id: string; slug: string }>(
      'insert into app.fixture_par_notes (title) values ($1) returning id, slug',
      [title],
    );
    expect(rows[0].slug).toBe(`order-tiles-${stamp}`);
    await expect(
      db.query("insert into app.fixture_par_notes (title) values ('  ')"),
    ).rejects.toThrow(/fixture_par_notes_title_not_blank/);
    await db.query('delete from app.fixture_par_notes where id = $1', [rows[0].id]);
  });

  it('runs again without changing anything: hooks are idempotent', async () => {
    await runMigrations(url, [...(fixture.definition.migrations ?? []), ...featureMigrations]);
    expect(
      await count(
        "select count(*)::int as n from pg_trigger where tgname = 'fixture_par_fill_slug'",
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from pg_constraint where conname = 'fixture_par_notes_title_not_blank'",
      ),
    ).toBe(1);
    expect(await count('select count(*)::int as n from drizzle.__fixture_par_migrations')).toBe(1);
  });
});

describe('runMigrations', () => {
  it('applies a set once when two migrates run at the same time (the lock)', async () => {
    const table = `app.test_lock_${stamp}`;
    drop.push(table);
    const set = tempSet(`lock_${stamp}`, [
      { tag: '0000_lock', when: 1_000, sql: `CREATE TABLE ${table} (id int)` },
    ]);
    await Promise.all([runMigrations(url, [set]), runMigrations(url, [set])]);
    expect(await count(`select count(*)::int as n from drizzle."${set.table}"`)).toBe(1);
    expect(await exists(table)).toBe(true);
  });

  it('refuses a migration drizzle would skip, before changing anything', async () => {
    const [early, late] = [`app.test_early_${stamp}`, `app.test_late_${stamp}`];
    drop.push(early, late);
    const lateOne = { tag: '0001_late', when: 2_000, sql: `CREATE TABLE ${late} (id int)` };
    const set = tempSet(`skip_${stamp}`, [lateOne]);
    await runMigrations(url, [set]);
    // A branch merged afterwards brings a migration generated before the applied one.
    writeMigrations(set, [
      { tag: '0000_early', when: 1_000, sql: `CREATE TABLE ${early} (id int)` },
      lateOne,
    ]);
    await expect(runMigrations(url, [set])).rejects.toThrow(/0000_early/);
    expect(await exists(early)).toBe(false);
  });

  it('stops at a failing hook, names its file, and runs no migration after it', async () => {
    const table = `app.test_hook_${stamp}`;
    drop.push(table);
    const set = tempSet(
      `hook_${stamp}`,
      [{ tag: '0000_hook', when: 1_000, sql: `CREATE TABLE ${table} (id int)` }],
      { '10-broken.sql': 'SELECT * FROM app.no_such_table;' },
    );
    await expect(runMigrations(url, [set])).rejects.toThrow(/10-broken\.sql/);
    expect(await exists(table)).toBe(false);
  });

  it('refuses two sets that record into the same table', async () => {
    const set = { folder: join(tmp, 'none'), table: '__fixture_migrations' };
    await expect(runMigrations(url, [set, set])).rejects.toThrow(/__fixture_migrations/);
  });
});
