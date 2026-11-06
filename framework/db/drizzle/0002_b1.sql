CREATE TABLE "app"."files" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text,
	"contact_id" text,
	"source" text DEFAULT 'upload' NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text,
	"intended_type" text,
	"intended_field" text,
	"resource_type" text,
	"resource_id" text,
	"field" text,
	"transcript" text,
	"transcript_lang" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upload_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"detached_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_key_idx" ON "app"."files" USING btree ("key");--> statement-breakpoint
CREATE INDEX "files_resource_idx" ON "app"."files" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "files_owner_status_idx" ON "app"."files" USING btree ("owner_id","status","created_at");--> statement-breakpoint
CREATE INDEX "files_contact_idx" ON "app"."files" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "files_sweep_idx" ON "app"."files" USING btree ("status","detached_at","created_at") WHERE "app"."files"."status" <> 'ready';