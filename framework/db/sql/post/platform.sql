-- The platform tier (B19): a support grant's mode and how it ended, a routed request's status,
-- and that a consented grant always has its end. Idempotent: runs on every migrate, and does
-- nothing until the tables exist.

DO $$
BEGIN
  IF to_regclass('app.platform_support_grants') IS NULL OR to_regclass('app.platform_routed') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_support_grants_access_check') THEN
    ALTER TABLE app.platform_support_grants ADD CONSTRAINT platform_support_grants_access_check
      CHECK (access IN ('read', 'write'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_support_grants_ended_check') THEN
    ALTER TABLE app.platform_support_grants ADD CONSTRAINT platform_support_grants_ended_check
      CHECK (ended_how IS NULL OR ended_how IN ('revoked', 'ended'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_support_grants_consent_check') THEN
    ALTER TABLE app.platform_support_grants ADD CONSTRAINT platform_support_grants_consent_check
      CHECK ((consented_at IS NULL) = (ends_at IS NULL) AND minutes > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_routed_status_check') THEN
    ALTER TABLE app.platform_routed ADD CONSTRAINT platform_routed_status_check
      CHECK (status IN ('routed', 'unrouted', 'failed'));
  END IF;
END $$;
