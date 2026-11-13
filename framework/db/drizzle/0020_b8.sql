CREATE TABLE "audit"."acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"name" text NOT NULL,
	"method" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"record_version" integer,
	"document_id" text NOT NULL,
	"document_name" text NOT NULL,
	"document_version" integer NOT NULL,
	"document_sha256" text NOT NULL,
	"document_file_name" text NOT NULL,
	"statement" text NOT NULL,
	"lang" text NOT NULL,
	"signer_kind" text NOT NULL,
	"signer_user_id" text,
	"signer_contact_id" text,
	"signer_customer_id" text,
	"signer_name" text,
	"challenge_id" text,
	"otp_channel" text,
	"otp_address" text,
	"otp_sent_at" timestamp with time zone,
	"otp_verified_at" timestamp with time zone,
	"esign_provider" text,
	"esign_ref" text,
	"esign_certificate" jsonb,
	"ip" text,
	"forwarded_for" text,
	"user_agent" text,
	"device" jsonb,
	"channel" text,
	"assurance" text,
	"request_id" text,
	"accepted_at" timestamp with time zone NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel"."otp_challenges" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text,
	"contact_id" text,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"resource_type" text,
	"resource_id" text,
	"binding" jsonb,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."documents" ADD COLUMN "record_version" integer;--> statement-breakpoint
ALTER TABLE "channel"."otp_challenges" ADD CONSTRAINT "otp_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."otp_challenges" ADD CONSTRAINT "otp_challenges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."otp_challenges" ADD CONSTRAINT "otp_challenges_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acceptances_tenant_seq_idx" ON "audit"."acceptances" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "acceptances_resource_idx" ON "audit"."acceptances" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "acceptances_document_idx" ON "audit"."acceptances" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "otp_challenges_address_idx" ON "channel"."otp_challenges" USING btree ("purpose","address","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_user_idx" ON "channel"."otp_challenges" USING btree ("purpose","user_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_contact_idx" ON "channel"."otp_challenges" USING btree ("purpose","contact_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_resource_idx" ON "channel"."otp_challenges" USING btree ("tenant_id","resource_type","resource_id");