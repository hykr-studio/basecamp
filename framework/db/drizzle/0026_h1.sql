ALTER TABLE "app"."outbox" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD COLUMN "undo_id" text;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD COLUMN "xact" bigint DEFAULT (pg_current_xact_id()::text)::bigint;