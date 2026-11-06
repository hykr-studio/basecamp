import { fileURLToPath } from 'node:url';
import type { MigrationSet } from '@hykr/db';

/**
 * The application's migrations (drizzle/), run after the framework's: one journal for every
 * module, generated from src/modules/<name>/db/schema.ts (drizzle.config.ts).
 */
export const migrations: MigrationSet = {
  folder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  table: '__app_migrations',
};
