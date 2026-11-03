CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE SCHEMA "channel";
--> statement-breakpoint
CREATE TABLE "app"."approvals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text,
	"requester_contact_id" text,
	"approver_user_id" text,
	"approver_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"approver_channels" text[],
	"min_assurance" text,
	"action" text NOT NULL,
	"rule" text NOT NULL,
	"reason" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"summary" text,
	"payload" jsonb,
	"requested_by" text DEFAULT 'agent' NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."channel_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."idempotency" (
	"key" text NOT NULL,
	"principal_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_principal_id_pk" PRIMARY KEY("key","principal_id")
);
--> statement-breakpoint
CREATE TABLE "app"."outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."pages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."thread_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channel" text DEFAULT 'app' NOT NULL,
	"lang" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."threads" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text,
	"contact_id" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_one_subject" CHECK (("app"."threads"."owner_id" is null) <> ("app"."threads"."contact_id" is null))
);
--> statement-breakpoint
CREATE TABLE "audit"."events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"acting_for" text,
	"tenant_id" text,
	"subject_kind" text,
	"run_id" text,
	"request_id" text,
	"approved_by" text,
	"agent_version" text,
	"channel" text,
	"rule" text,
	"reason" text,
	"outcome" text DEFAULT 'committed' NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel"."consents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"topic" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel"."contacts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"address" text NOT NULL,
	"profile_name" text,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"user_id" text,
	"customer_id" text,
	"linked_at" timestamp with time zone,
	"welcomed_at" timestamp with time zone,
	"unreachable_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel"."handoffs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"taken_by" text,
	"reason" text NOT NULL,
	"resolution" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"flagged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel"."inbound_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"provider_message_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"from" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "channel"."link_codes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"address" text NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel"."messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"contact_id" text,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"direction" text NOT NULL,
	"provider_message_id" text,
	"kind" text NOT NULL,
	"body" jsonb,
	"template" text,
	"category" text,
	"status" text NOT NULL,
	"run_id" text,
	"error_code" integer,
	"notification" text,
	"meta" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel"."numbers" (
	"phone_number_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel"."templates" (
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"provider_id" text,
	"rejected_reason" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."customers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"user_id" text,
	"contact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."memberships" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"customer_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."tenants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"default_owner_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD CONSTRAINT "approvals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_links" ADD CONSTRAINT "channel_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_links" ADD CONSTRAINT "channel_links_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pages" ADD CONSTRAINT "pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pages" ADD CONSTRAINT "pages_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."thread_messages" ADD CONSTRAINT "thread_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "app"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."consents" ADD CONSTRAINT "consents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."contacts" ADD CONSTRAINT "contacts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."handoffs" ADD CONSTRAINT "handoffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."handoffs" ADD CONSTRAINT "handoffs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."link_codes" ADD CONSTRAINT "link_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."link_codes" ADD CONSTRAINT "link_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."numbers" ADD CONSTRAINT "numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tenants" ADD CONSTRAINT "tenants_default_owner_id_user_id_fk" FOREIGN KEY ("default_owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_owner_status_idx" ON "app"."approvals" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "approvals_tenant_status_idx" ON "app"."approvals" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_address_idx" ON "app"."channel_links" USING btree ("channel","address");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_owner_idx" ON "app"."channel_links" USING btree ("channel","owner_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "app"."outbox" USING btree ("id") WHERE "app"."outbox"."relayed_at" is null;--> statement-breakpoint
CREATE INDEX "pages_owner_name_idx" ON "app"."pages" USING btree ("owner_id","name");--> statement-breakpoint
CREATE INDEX "thread_messages_thread_created_idx" ON "app"."thread_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_messages_thread_seq_idx" ON "app"."thread_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "threads_owner_updated_idx" ON "app"."threads" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "threads_contact_updated_idx" ON "app"."threads" USING btree ("contact_id","updated_at");--> statement-breakpoint
CREATE INDEX "events_resource_idx" ON "audit"."events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "audit"."events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "audit"."events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "events_request_idx" ON "audit"."events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "events_tenant_at_idx" ON "audit"."events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "consents_contact_topic_idx" ON "channel"."consents" USING btree ("contact_id","topic","at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_address_idx" ON "channel"."contacts" USING btree ("tenant_id","channel","address");--> statement-breakpoint
CREATE INDEX "contacts_user_idx" ON "channel"."contacts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_one_open_idx" ON "channel"."handoffs" USING btree ("contact_id") WHERE "channel"."handoffs"."state" <> 'closed';--> statement-breakpoint
CREATE INDEX "handoffs_tenant_state_idx" ON "channel"."handoffs" USING btree ("tenant_id","state","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_provider_idx" ON "channel"."inbound_events" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "inbound_events_sender_idx" ON "channel"."inbound_events" USING btree ("phone_number_id","from","processed_at");--> statement-breakpoint
CREATE INDEX "inbound_events_received_idx" ON "channel"."inbound_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "messages_window_idx" ON "channel"."messages" USING btree ("contact_id","direction","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_idx" ON "channel"."messages" USING btree ("provider_message_id") WHERE "channel"."messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_name_language_idx" ON "channel"."templates" USING btree ("name","language");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_user_idx" ON "app"."customers" USING btree ("tenant_id","user_id") WHERE "app"."customers"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_contact_idx" ON "app"."customers" USING btree ("tenant_id","contact_id") WHERE "app"."customers"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "customers_tenant_idx" ON "app"."customers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_default_idx" ON "app"."memberships" USING btree ("user_id") WHERE "app"."memberships"."is_default";