CREATE TABLE "app"."share_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"form" text,
	"label" text,
	"created_by" text NOT NULL,
	"contact_id" text,
	"customer_id" text,
	"email" text,
	"otp_channel" text,
	"otp_address" text,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."share_sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"link_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"challenge_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."share_links" ADD CONSTRAINT "share_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_links" ADD CONSTRAINT "share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_links" ADD CONSTRAINT "share_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_links" ADD CONSTRAINT "share_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_sessions" ADD CONSTRAINT "share_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_sessions" ADD CONSTRAINT "share_sessions_link_id_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "app"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_idx" ON "app"."share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_target_idx" ON "app"."share_links" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "share_links_form_idx" ON "app"."share_links" USING btree ("tenant_id","form") WHERE "app"."share_links"."form" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "share_sessions_token_idx" ON "app"."share_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_sessions_link_idx" ON "app"."share_sessions" USING btree ("link_id");