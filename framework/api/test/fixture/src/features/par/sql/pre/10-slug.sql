-- Runs before the par migrations, on every migrate: CREATE OR REPLACE keeps it idempotent.
CREATE OR REPLACE FUNCTION app.fixture_par_slug(title text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g')) $$;
