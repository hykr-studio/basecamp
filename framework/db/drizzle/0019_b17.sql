CREATE TABLE "app"."calendar_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"tokens_sealed" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"sync_token" text,
	"channel_id" text,
	"channel_resource_id" text,
	"channel_expires_at" timestamp with time zone,
	"inbound_connection_id" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"queues" text DEFAULT 'bull' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."calendar_event_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"external_id" text NOT NULL,
	"status" text DEFAULT 'synced' NOT NULL,
	"hash" text,
	"sent_starts_at" timestamp with time zone,
	"sent_ends_at" timestamp with time zone,
	"external_starts_at" timestamp with time zone,
	"external_ends_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."calendar_feeds" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."calendar_invites" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"user_id" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'REQUEST' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"requested_by" text,
	"sent" jsonb,
	"sent_hash" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."calendar_oauth_states" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_sealed" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."call_logs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"from_number" text,
	"to_number" text,
	"user_id" text,
	"resource_type" text,
	"resource_id" text,
	"provider" text,
	"external_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_s" integer,
	"notes" text,
	"error" text,
	"created_by" text DEFAULT 'person' NOT NULL,
	"logged_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."calendar_connections" ADD CONSTRAINT "calendar_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_connections" ADD CONSTRAINT "calendar_connections_inbound_connection_id_integration_connections_id_fk" FOREIGN KEY ("inbound_connection_id") REFERENCES "app"."integration_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_event_links" ADD CONSTRAINT "calendar_event_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_event_links" ADD CONSTRAINT "calendar_event_links_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_feeds" ADD CONSTRAINT "calendar_feeds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_invites" ADD CONSTRAINT "calendar_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_invites" ADD CONSTRAINT "calendar_invites_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_invites" ADD CONSTRAINT "calendar_invites_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_oauth_states" ADD CONSTRAINT "calendar_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calendar_oauth_states" ADD CONSTRAINT "calendar_oauth_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."call_logs" ADD CONSTRAINT "call_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."call_logs" ADD CONSTRAINT "call_logs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."call_logs" ADD CONSTRAINT "call_logs_logged_by_user_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_person_uq" ON "app"."calendar_connections" USING btree ("tenant_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "calendar_connections_queues_idx" ON "app"."calendar_connections" USING btree ("queues","status");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_links_record_uq" ON "app"."calendar_event_links" USING btree ("connection_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "calendar_event_links_resource_idx" ON "app"."calendar_event_links" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "calendar_event_links_external_idx" ON "app"."calendar_event_links" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feeds_token_uq" ON "app"."calendar_feeds" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "calendar_feeds_person_idx" ON "app"."calendar_feeds" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_invites_recipient_uq" ON "app"."calendar_invites" USING btree ("tenant_id","resource_type","resource_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_oauth_states_state_uq" ON "app"."calendar_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "calendar_oauth_states_expires_idx" ON "app"."calendar_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "call_logs_resource_idx" ON "app"."call_logs" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "call_logs_person_idx" ON "app"."call_logs" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "call_logs_external_uq" ON "app"."call_logs" USING btree ("tenant_id","provider","external_id");