import { defineConfig } from 'drizzle-kit';

// The fixture's own tables: `pnpm fixture:generate --name <name>` (in framework/api). A feature's
// tables, in a set of their own (src/features/<f>/migrations, found by src/migrations.ts), so
// parallel features never share a journal: `FIXTURE_FEATURE=<f> pnpm fixture:generate --name <f>`.
const feature = process.env.FIXTURE_FEATURE;

export default defineConfig(
  feature
    ? {
        dialect: 'postgresql',
        schema: `./src/features/${feature}/schema.ts`,
        out: `./src/features/${feature}/migrations`,
        migrations: {
          schema: 'drizzle',
          table: `__fixture_${feature.replaceAll('-', '_')}_migrations`,
        },
        schemaFilter: ['app'],
        extensionsFilters: ['postgis'],
      }
    : {
        dialect: 'postgresql',
        schema: './src/schema.ts',
        out: './drizzle',
        migrations: { schema: 'drizzle', table: '__fixture_migrations' },
        schemaFilter: ['app'],
        extensionsFilters: ['postgis'],
      },
);
