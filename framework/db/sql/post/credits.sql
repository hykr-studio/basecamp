-- Credits and caps (A3): what the tables may hold, and the ledger and usage rows never change
-- once written (a business's deletion still removes them, by cascade). Idempotent: runs on every
-- migrate, and does nothing until the tables exist.

CREATE OR REPLACE FUNCTION app.credits_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never changed once written', TG_TABLE_NAME;
END;
$$;

DO $$
BEGIN
  IF to_regclass('app.credit_ledger') IS NULL OR to_regclass('app.usage_events') IS NULL
    OR to_regclass('app.credit_purchases') IS NULL OR to_regclass('app.credit_alerts') IS NULL THEN
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS credit_ledger_append_only ON app.credit_ledger;
  CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE ON app.credit_ledger
    FOR EACH ROW EXECUTE FUNCTION app.credits_append_only();
  DROP TRIGGER IF EXISTS usage_events_append_only ON app.usage_events;
  CREATE TRIGGER usage_events_append_only BEFORE UPDATE ON app.usage_events
    FOR EACH ROW EXECUTE FUNCTION app.credits_append_only();

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_ledger_kind_check') THEN
    ALTER TABLE app.credit_ledger ADD CONSTRAINT credit_ledger_kind_check
      CHECK ((kind = 'debit' AND amount < 0) OR (kind IN ('topup', 'grant') AND amount > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_purchases_check') THEN
    ALTER TABLE app.credit_purchases ADD CONSTRAINT credit_purchases_check
      CHECK (amount > 0 AND status IN ('requested', 'open', 'paid', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_amounts_check') THEN
    ALTER TABLE app.usage_events ADD CONSTRAINT usage_events_amounts_check
      CHECK (quantity > 0 AND cost >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_alerts_level_check') THEN
    ALTER TABLE app.credit_alerts ADD CONSTRAINT credit_alerts_level_check
      CHECK (level IN ('alert', 'pause'));
  END IF;
END;
$$;
