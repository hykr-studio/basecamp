CREATE TABLE "app"."job_updates" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"job_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"dedupe" text NOT NULL,
	"status" text NOT NULL,
	"body" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "app"."jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer,
	"message" text,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"result_files" text[] DEFAULT '{}'::text[] NOT NULL,
	"external_id" text,
	"about_type" text,
	"about_id" text,
	"started_for" text,
	"started_by_kind" text NOT NULL,
	"started_by_id" text NOT NULL,
	"request_id" text,
	"principal" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"completion" text,
	"completion_attempts" integer DEFAULT 0 NOT NULL,
	"completion_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."job_updates" ADD CONSTRAINT "job_updates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."job_updates" ADD CONSTRAINT "job_updates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_updates_dedupe_idx" ON "app"."job_updates" USING btree ("job_id","dedupe");--> statement-breakpoint
CREATE INDEX "job_updates_pending_idx" ON "app"."job_updates" USING btree ("received_at") WHERE "app"."job_updates"."applied_at" is null;--> statement-breakpoint
CREATE INDEX "jobs_about_idx" ON "app"."jobs" USING btree ("tenant_id","about_type","about_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_started_for_idx" ON "app"."jobs" USING btree ("tenant_id","started_for","created_at");--> statement-breakpoint
CREATE INDEX "jobs_external_idx" ON "app"."jobs" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "jobs_open_idx" ON "app"."jobs" USING btree ("status","deadline_at") WHERE "app"."jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_poll_idx" ON "app"."jobs" USING btree ("next_poll_at") WHERE "app"."jobs"."status" = 'running' and "app"."jobs"."next_poll_at" is not null;