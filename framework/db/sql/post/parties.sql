-- Parties (B7): a party is a person or an organisation, and each of its members is reached
-- somehow: an account, a WhatsApp contact, or an invitation by email still waiting. Idempotent:
-- runs on every migrate, and does nothing until the tables exist.

DO $$
BEGIN
  IF to_regclass('app.parties') IS NULL OR to_regclass('app.party_members') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parties_kind_check') THEN
    ALTER TABLE app.parties ADD CONSTRAINT parties_kind_check
      CHECK (kind IN ('person', 'organisation'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_members_reached_check') THEN
    ALTER TABLE app.party_members ADD CONSTRAINT party_members_reached_check
      CHECK (user_id IS NOT NULL OR contact_id IS NOT NULL
        OR (email IS NOT NULL AND token_hash IS NOT NULL AND expires_at IS NOT NULL));
  END IF;
END $$;
