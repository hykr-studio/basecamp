-- Runs after the par migrations, on every migrate: a trigger on their table, and a CHECK
-- constraint drizzle-kit would not generate. Each statement is safe to run again.
CREATE OR REPLACE FUNCTION app.fixture_par_fill_slug() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.slug := app.fixture_par_slug(NEW.title);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS fixture_par_fill_slug ON app.fixture_par_notes;
CREATE TRIGGER fixture_par_fill_slug
  BEFORE INSERT OR UPDATE OF title ON app.fixture_par_notes
  FOR EACH ROW EXECUTE FUNCTION app.fixture_par_fill_slug();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fixture_par_notes_title_not_blank'
  ) THEN
    ALTER TABLE app.fixture_par_notes
      ADD CONSTRAINT fixture_par_notes_title_not_blank CHECK (length(trim(title)) > 0);
  END IF;
END
$$;
