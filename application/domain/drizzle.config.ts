import { defineConfig } from 'drizzle-kit';

const url =
  process.env.MIGRATE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://app:app@localhost:5432/app';

// The application's own tables. The framework's (users, tenancy, approvals, channels) ship with
// @hykr/db and run first; `basecamp db migrate` applies both.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
  migrations: { schema: 'drizzle', table: '__app_migrations' },
  schemaFilter: ['app'],
});
