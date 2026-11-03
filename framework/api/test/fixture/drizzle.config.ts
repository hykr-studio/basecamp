import { defineConfig } from 'drizzle-kit';

// The fixture's own tables, generated once: `npx drizzle-kit generate` in this folder.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  migrations: { schema: 'drizzle', table: '__fixture_migrations' },
  schemaFilter: ['app'],
});
