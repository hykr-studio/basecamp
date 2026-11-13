ALTER TABLE "channel"."contacts" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "channel"."contacts" ALTER COLUMN "time_zone" SET DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "channel"."link_codes" ALTER COLUMN "time_zone" SET DEFAULT 'UTC';