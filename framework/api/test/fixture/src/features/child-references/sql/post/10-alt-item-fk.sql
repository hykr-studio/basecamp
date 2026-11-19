-- Runs after the child-references migrations, on every migrate: a line's alt_item_id names a
-- price item of its own business, and the item's delete clears it (and only it: tenant_id is
-- NOT NULL). Drizzle cannot say a column list for SET NULL, so the key is here, added once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fixture_sheets_lines_alt_item_fk'
      AND conrelid = 'app.fixture_sheets_lines'::regclass
  ) THEN
    ALTER TABLE app.fixture_sheets_lines
      ADD CONSTRAINT fixture_sheets_lines_alt_item_fk
      FOREIGN KEY (tenant_id, alt_item_id)
      REFERENCES app.fixture_sheets_items (tenant_id, id)
      ON DELETE SET NULL (alt_item_id);
  END IF;
END
$$;
