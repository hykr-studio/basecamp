CREATE TABLE "app"."outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relayed_at" timestamp with time zone
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
ALTER TABLE "channel"."contacts" ADD COLUMN "welcomed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel"."contacts" ADD COLUMN "unreachable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."consents" ADD CONSTRAINT "consents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."handoffs" ADD CONSTRAINT "handoffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."handoffs" ADD CONSTRAINT "handoffs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."link_codes" ADD CONSTRAINT "link_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."link_codes" ADD CONSTRAINT "link_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."numbers" ADD CONSTRAINT "numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "app"."outbox" USING btree ("id") WHERE "app"."outbox"."relayed_at" is null;--> statement-breakpoint
CREATE INDEX "consents_contact_topic_idx" ON "channel"."consents" USING btree ("contact_id","topic","at");--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_one_open_idx" ON "channel"."handoffs" USING btree ("contact_id") WHERE "channel"."handoffs"."state" <> 'closed';--> statement-breakpoint
CREATE INDEX "handoffs_tenant_state_idx" ON "channel"."handoffs" USING btree ("tenant_id","state","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_provider_idx" ON "channel"."inbound_events" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "inbound_events_sender_idx" ON "channel"."inbound_events" USING btree ("phone_number_id","from","processed_at");--> statement-breakpoint
CREATE INDEX "inbound_events_received_idx" ON "channel"."inbound_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "messages_window_idx" ON "channel"."messages" USING btree ("contact_id","direction","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_idx" ON "channel"."messages" USING btree ("provider_message_id") WHERE "channel"."messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_name_language_idx" ON "channel"."templates" USING btree ("name","language");