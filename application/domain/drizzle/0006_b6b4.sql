ALTER TABLE "app"."orders" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "series_id" text;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;