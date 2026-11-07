CREATE TABLE "app"."member_invites" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"roles" text[] NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."record_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."member_invites" ADD CONSTRAINT "member_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."record_grants" ADD CONSTRAINT "record_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."record_grants" ADD CONSTRAINT "record_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_invites_token_idx" ON "app"."member_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "member_invites_tenant_idx" ON "app"."member_invites" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "record_grants_one_idx" ON "app"."record_grants" USING btree ("tenant_id","resource_type","resource_id","user_id");--> statement-breakpoint
CREATE INDEX "record_grants_user_idx" ON "app"."record_grants" USING btree ("tenant_id","user_id","resource_type","resource_id");