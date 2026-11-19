CREATE TABLE "app"."document_sends" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"recipient" jsonb NOT NULL,
	"channel" text,
	"address" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"message_id" text,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."documents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"version" integer NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"data" jsonb NOT NULL,
	"seen_as" jsonb NOT NULL,
	"requested_by" text,
	"requested_by_contact" text,
	"created_by" text DEFAULT 'person' NOT NULL,
	"file_name" text NOT NULL,
	"mime" text DEFAULT 'application/pdf' NOT NULL,
	"file_id" text,
	"size" bigint,
	"pages" integer,
	"sha256" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rendered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."document_sends" ADD CONSTRAINT "document_sends_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_sends" ADD CONSTRAINT "document_sends_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_sends" ADD CONSTRAINT "document_sends_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "channel"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_sends" ADD CONSTRAINT "document_sends_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_requested_by_contact_contacts_id_fk" FOREIGN KEY ("requested_by_contact") REFERENCES "channel"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_sends_document_idx" ON "app"."document_sends" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_sends_waiting_idx" ON "app"."document_sends" USING btree ("status","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_version_idx" ON "app"."documents" USING btree ("tenant_id","name","resource_type","resource_id","version");--> statement-breakpoint
CREATE INDEX "documents_resource_idx" ON "app"."documents" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "documents_requested_by_idx" ON "app"."documents" USING btree ("requested_by");