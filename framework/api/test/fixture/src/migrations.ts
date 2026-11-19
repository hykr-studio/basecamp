// Each fixture feature's own migration set: src/features/<f>/migrations (generated with
// `FIXTURE_FEATURE=<f> pnpm fixture:generate --name <f>`), recorded in
// drizzle.__fixture_<f>_migrations, with SQL hooks in src/features/<f>/sql/{pre,post}. Found by
// folder name, so a feature adds its folder and edits nothing shared. The framework e2e setup
// (test/setup.ts) applies them after the fixture's own tables.
import { fileURLToPath } from 'node:url';
import { migrationSetsIn } from '@hykr/db';

/** From dist/: the sources hold the generated SQL (tsc copies only TypeScript). */
export const featureMigrations = migrationSetsIn(
  fileURLToPath(new URL('../src/features', import.meta.url)),
  'fixture',
);
