CREATE TABLE "app"."agent_condition_hits" (
	"trigger_id" text NOT NULL,
	"record_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_condition_hits_trigger_id_record_id_pk" PRIMARY KEY("trigger_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "app"."agent_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text NOT NULL,
	"trigger_id" text,
	"trigger_kind" text NOT NULL,
	"trigger_label" text DEFAULT '' NOT NULL,
	"input" jsonb,
	"dedupe" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"reply" text,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"model" text,
	"agent_version" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"thread_id" text,
	"queues" text DEFAULT 'bull' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_triggers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"next_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"queues" text DEFAULT 'bull' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" jsonb DEFAULT '{"tools":[]}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{"period":"month","maxSteps":6}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"template" text,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."threads" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "app"."agent_condition_hits" ADD CONSTRAINT "agent_condition_hits_trigger_id_agent_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "app"."agent_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_runs" ADD CONSTRAINT "agent_runs_trigger_id_agent_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "app"."agent_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_triggers" ADD CONSTRAINT "agent_triggers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_triggers" ADD CONSTRAINT "agent_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_run_id_idx" ON "app"."agent_runs" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_dedupe_idx" ON "app"."agent_runs" USING btree ("agent_id","dedupe");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_created_idx" ON "app"."agent_runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_created_idx" ON "app"."agent_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_open_idx" ON "app"."agent_runs" USING btree ("queues","status","updated_at") WHERE "app"."agent_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_triggers_agent_position_idx" ON "app"."agent_triggers" USING btree ("agent_id","position");--> statement-breakpoint
CREATE INDEX "agent_triggers_due_idx" ON "app"."agent_triggers" USING btree ("queues","next_at") WHERE "app"."agent_triggers"."next_at" is not null;--> statement-breakpoint
CREATE INDEX "agent_triggers_tenant_kind_idx" ON "app"."agent_triggers" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "agents_tenant_updated_idx" ON "app"."agents" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "app"."agents" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threads_agent_idx" ON "app"."threads" USING btree ("agent_id") WHERE "app"."threads"."agent_id" is not null;