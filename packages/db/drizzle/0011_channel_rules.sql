-- Consents are a record of what each contact agreed to, and when: rows are added, never changed.
-- (Deleting a contact's data still removes them.)
CREATE OR REPLACE FUNCTION "channel"."consents_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'channel.consents is append-only: add a row instead';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "consents_no_update" BEFORE UPDATE ON "channel"."consents"
FOR EACH ROW EXECUTE FUNCTION "channel"."consents_append_only"();
--> statement-breakpoint
-- Numbers already linked to accounts (app.channel_links) become linked contacts.
INSERT INTO "channel"."contacts" ("tenant_id", "channel", "address", "time_zone", "user_id", "linked_at", "created_at")
SELECT l."tenant_id", 'whatsapp', l."address", l."time_zone", l."owner_id", l."created_at", l."created_at"
FROM "app"."channel_links" l
WHERE l."channel" = 'whatsapp'
ON CONFLICT DO NOTHING;
