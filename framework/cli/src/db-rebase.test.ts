// `basecamp db rebase`: a branch's own migrations are dropped and the base's restored, in a
// temporary git repository.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropBranchMigrations } from './db-rebase.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe',
  });

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'db-rebase-'));
  const pkg = join(root, 'domain');
  mkdirSync(join(pkg, 'drizzle', 'meta'), { recursive: true });
  writeFileSync(join(pkg, 'drizzle', '0000_domain.sql'), 'CREATE TABLE a ();');
  writeFileSync(join(pkg, 'drizzle', 'meta', '_journal.json'), '{"entries":["0000"]}');
  writeFileSync(join(pkg, 'drizzle', 'meta', '0000_snapshot.json'), '{}');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  return { root, pkg };
}

describe('basecamp db rebase', () => {
  it("drops the branch's migrations and restores the base's journal", () => {
    const { pkg } = repo();
    writeFileSync(join(pkg, 'drizzle', '0001_wip_orders.sql'), 'CREATE TABLE orders ();');
    writeFileSync(join(pkg, 'drizzle', 'meta', '0001_snapshot.json'), '{}');
    writeFileSync(join(pkg, 'drizzle', 'meta', '_journal.json'), '{"entries":["0000","0001"]}');
    const result = dropBranchMigrations(pkg, 'main');
    expect(result.dropped.sort()).toEqual(['0001_wip_orders.sql', 'meta/0001_snapshot.json']);
    expect(result.name).toBe('wip_orders');
    expect(existsSync(join(pkg, 'drizzle', '0001_wip_orders.sql'))).toBe(false);
    expect(readFileSync(join(pkg, 'drizzle', 'meta', '_journal.json'), 'utf8')).toBe(
      '{"entries":["0000"]}',
    );
    expect(existsSync(join(pkg, 'drizzle', '0000_domain.sql'))).toBe(true);
  });

  it('keeps a given name, drops nothing when the branch has nothing, and refuses an unknown base', () => {
    const { pkg } = repo();
    expect(dropBranchMigrations(pkg, 'main', 'orders')).toEqual({ dropped: [], name: 'orders' });
    expect(() => dropBranchMigrations(pkg, 'no-such-branch')).toThrow();
  });
});
