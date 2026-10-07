ALTER TABLE "app"."meetings" ADD COLUMN "created_by" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD COLUMN "created_by" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."todos" ADD COLUMN "created_by" text DEFAULT 'person' NOT NULL;