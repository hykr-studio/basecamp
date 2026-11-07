CREATE TABLE "app"."sla_timers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"sla" text NOT NULL,
	"state" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"hours" text DEFAULT 'all' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"escalate" jsonb,
	"escalation_error" text,
	"queues" text DEFAULT 'bull' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."sla_timers" ADD CONSTRAINT "sla_timers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sla_timers_due_idx" ON "app"."sla_timers" USING btree ("queues","due_at") WHERE "app"."sla_timers"."status" = 'running';--> statement-breakpoint
CREATE INDEX "sla_timers_resource_idx" ON "app"."sla_timers" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "sla_timers_status_idx" ON "app"."sla_timers" USING btree ("tenant_id","status","due_at");