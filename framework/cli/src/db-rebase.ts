// `basecamp db rebase`: after a rebase (or a merge from the base branch), throw away this branch's
// generated migrations and generate them again on top of the base's. Two branches that each
// generated a migration in the one journal otherwise collide (the same index, snapshots that
// share a parent), and drizzle silently skips a migration whose journal time is older than one
// already applied.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type DbRebaseResult = {
  /** Migration files the base does not have, removed (relative to the migrations folder). */
  dropped: string[];
  /** The name to generate the replacement with. */
  name: string;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Every file under a folder, relative to it. */
function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? filesUnder(path, `${prefix}${entry}/`)
      : [`${prefix}${entry}`];
  });
}

/**
 * Put `<pkg>/drizzle` back to what `base` has: its files restored, the files it does not have
 * removed. Returns what was dropped and the name to generate again with (`--name`, or the
 * dropped migration's own name without its number). The caller then runs drizzle-kit generate.
 */
export function dropBranchMigrations(pkg: string, base: string, name?: string): DbRebaseResult {
  // Real paths: git answers with them (a temporary folder is often behind a symlink).
  const folder = join(realpathSync(pkg), 'drizzle');
  const top = git(pkg, 'rev-parse', '--show-toplevel');
  const path = relative(top, folder);
  git(top, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`);
  const tracked = new Set(
    git(top, 'ls-tree', '-r', '--name-only', base, '--', path)
      .split('\n')
      .filter(Boolean)
      .map((f) => relative(path, f)),
  );
  const dropped = filesUnder(folder).filter((f) => !tracked.has(f));
  for (const file of dropped) rmSync(join(folder, file));
  if (tracked.size) git(top, 'checkout', base, '--', path);
  const sql = dropped.find((f) => /^\d{4}_.+\.sql$/.test(f));
  return { dropped, name: name ?? sql?.replace(/^\d{4}_/, '').replace(/\.sql$/, '') ?? 'rebase' };
}
