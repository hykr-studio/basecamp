import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { frameworkMigrations, migrationSetsIn, sqlHookFiles } from './migrate.js';

const root = mkdtempSync(join(tmpdir(), 'basecamp-sets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A folder with a drizzle journal, as drizzle-kit leaves it. */
function journal(dir: string) {
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [] }));
}

describe('migrationSetsIn', () => {
  it('makes one set per feature folder with migrations, in name order', () => {
    const features = join(root, 'features');
    journal(join(features, 'orders', 'migrations'));
    journal(join(features, 'line-items', 'migrations'));
    mkdirSync(join(features, 'no-tables', 'src'), { recursive: true }); // TypeScript only
    expect(migrationSetsIn(features, 'fixture')).toEqual([
      {
        folder: join(features, 'line-items', 'migrations'),
        table: '__fixture_line_items_migrations',
        sql: join(features, 'line-items', 'sql'),
      },
      {
        folder: join(features, 'orders', 'migrations'),
        table: '__fixture_orders_migrations',
        sql: join(features, 'orders', 'sql'),
      },
    ]);
  });

  it('refuses a name that cannot be a table name, and is empty without the folder', () => {
    const bad = join(root, 'bad');
    journal(join(bad, 'Orders', 'migrations'));
    expect(() => migrationSetsIn(bad, 'fixture')).toThrow(/lower-case/);
    expect(migrationSetsIn(join(root, 'missing'), 'fixture')).toEqual([]);
  });
});

describe('sqlHookFiles', () => {
  it('lists .sql files in name order, next to the migrations by default', () => {
    const set = { folder: join(root, 'app', 'drizzle'), table: '__app_migrations' };
    const pre = join(root, 'app', 'sql', 'pre');
    mkdirSync(pre, { recursive: true });
    for (const file of ['20-b.sql', '10-a.sql', 'notes.md']) writeFileSync(join(pre, file), '');
    expect(sqlHookFiles(set, 'pre')).toEqual([join(pre, '10-a.sql'), join(pre, '20-b.sql')]);
    expect(sqlHookFiles(set, 'post')).toEqual([]);
  });

  it('takes an explicit folder over the default', () => {
    const post = join(root, 'elsewhere', 'post');
    mkdirSync(post, { recursive: true });
    writeFileSync(join(post, 'trigger.sql'), '');
    const set = { ...frameworkMigrations, sql: join(root, 'elsewhere') };
    expect(sqlHookFiles(set, 'post')).toEqual([join(post, 'trigger.sql')]);
  });
});
