-- Acceptance evidence is append-only (decisions B8): a row, once written, is never changed or
-- removed, whoever asks. Idempotent: the function is replaced and the triggers made again on
-- every migrate. Skipped until the table exists.
DO $$
BEGIN
  IF to_regclass('audit.acceptances') IS NULL THEN
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION audit.acceptances_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'audit.acceptances is append-only: % is not allowed', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END
  $fn$;

  DROP TRIGGER IF EXISTS acceptances_append_only_rows ON audit.acceptances;
  CREATE TRIGGER acceptances_append_only_rows
    BEFORE UPDATE OR DELETE ON audit.acceptances
    FOR EACH ROW EXECUTE FUNCTION audit.acceptances_append_only();

  DROP TRIGGER IF EXISTS acceptances_append_only_truncate ON audit.acceptances;
  CREATE TRIGGER acceptances_append_only_truncate
    BEFORE TRUNCATE ON audit.acceptances
    FOR EACH STATEMENT EXECUTE FUNCTION audit.acceptances_append_only();
END
$$;
