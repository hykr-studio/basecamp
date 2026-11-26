# SQL hooks

What drizzle-kit does not generate for the application's tables: extensions, triggers,
functions and CHECK constraints. `basecamp db migrate` runs `pre/*.sql` before the migrations
in `../drizzle` and `post/*.sql` after them, every time, in name order, one transaction per
file. So every file must be idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF
EXISTS` then `CREATE TRIGGER`). Use one file per feature. See `framework/db/sql/README.md`.
