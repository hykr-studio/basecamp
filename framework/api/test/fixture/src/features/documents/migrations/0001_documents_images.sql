ALTER TABLE "app"."fixture_memos" ADD COLUMN "photo" text;--> statement-breakpoint
ALTER TABLE "app"."fixture_memos" ADD COLUMN "photos" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."fixture_memos" ADD COLUMN "secret_photo" text;