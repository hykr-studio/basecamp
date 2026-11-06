# SQL hooks

What drizzle-kit does not generate: extensions, triggers, functions and CHECK constraints.
`runMigrations` (`src/migrate.ts`) runs them around the framework's migrations, on every
`basecamp db migrate`:

- `pre/*.sql` before the migrations in `../drizzle` (for example, an extension a column needs);
- `post/*.sql` after them (for example, a trigger on a table they create).

Files run in name order. Put a number in front when the order matters (`10-postgis.sql`).
Each file runs as one transaction, so `CREATE INDEX CONCURRENTLY` cannot go here.

Every file runs on every migrate, so it must be idempotent: `CREATE EXTENSION IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`, and a `DO` block
that checks `pg_constraint` before `ADD CONSTRAINT`. One file per feature, named after it, so
parallel branches never edit the same file.

An application's hooks go in the same layout next to its migrations (`application/domain/sql`).
