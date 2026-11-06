CREATE TABLE "app"."domain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"module" text,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"row" jsonb,
	"before" jsonb,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"subject" text,
	"channel" text,
	"request_id" text,
	"run_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"queues" text DEFAULT 'bull' NOT NULL,
	"relayed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."domain_events" ADD CONSTRAINT "domain_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_events_pending_idx" ON "app"."domain_events" USING btree ("queues","available_at","seq") WHERE "app"."domain_events"."relayed_at" is null and "app"."domain_events"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "domain_events_resource_idx" ON "app"."domain_events" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "domain_events_request_idx" ON "app"."domain_events" USING btree ("request_id");