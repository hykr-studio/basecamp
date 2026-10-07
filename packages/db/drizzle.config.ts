import { defineConfig } from 'drizzle-kit';

const url =
  process.env.MIGRATE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://app:app@localhost:5432/app';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url },
  // Own public, app, and audit. Leave mastra and mastra_obs to Mastra.
  schemaFilter: ['public', 'app', 'audit'],
});
