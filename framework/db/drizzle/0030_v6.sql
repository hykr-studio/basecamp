DROP INDEX "app"."domain_events_pending_idx";--> statement-breakpoint
ALTER TABLE "app"."domain_events" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."domain_events" ADD COLUMN "error" text;--> statement-breakpoint
CREATE INDEX "domain_events_pending_idx" ON "app"."domain_events" USING btree ("queues","available_at","seq") WHERE "app"."domain_events"."relayed_at" is null and "app"."domain_events"."cancelled_at" is null and "app"."domain_events"."failed_at" is null;