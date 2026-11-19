-- Share links (B9): a link opens a record, a page or a form, and names exactly that; a code goes
-- by WhatsApp or email, to an address fixed when the link was made. Idempotent: runs on every
-- migrate, and does nothing until the table exists.

DO $$
BEGIN
  IF to_regclass('app.share_links') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_links_kind_check') THEN
    ALTER TABLE app.share_links ADD CONSTRAINT share_links_kind_check
      CHECK (kind IN ('record', 'page', 'form'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_links_target_check') THEN
    ALTER TABLE app.share_links ADD CONSTRAINT share_links_target_check
      CHECK ((kind = 'form' AND form IS NOT NULL AND resource_id IS NULL)
        OR (kind <> 'form' AND form IS NULL AND resource_type IS NOT NULL AND resource_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_links_otp_check') THEN
    ALTER TABLE app.share_links ADD CONSTRAINT share_links_otp_check
      CHECK ((otp_channel IS NULL AND otp_address IS NULL)
        OR (otp_channel IN ('whatsapp', 'email') AND otp_address IS NOT NULL));
  END IF;
END $$;
