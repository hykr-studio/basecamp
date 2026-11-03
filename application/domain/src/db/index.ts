import { fileURLToPath } from 'node:url';
import type { MigrationSet } from '@hykr/db';

export * from './schema.js';

/** The application's migrations (drizzle/), run after the framework's. */
export const migrations: MigrationSet = {
  folder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  table: '__app_migrations',
};
