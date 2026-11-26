CREATE TABLE "app"."custom_fields" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"label" jsonb NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"filterable" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."tenant_domains" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"origin" text NOT NULL,
	"token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."custom_fields" ADD CONSTRAINT "custom_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."custom_fields" ADD CONSTRAINT "custom_fields_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tenant_domains" ADD CONSTRAINT "tenant_domains_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_fields_tenant_entity_key_idx" ON "app"."custom_fields" USING btree ("tenant_id","entity","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_domains_verified_origin_idx" ON "app"."tenant_domains" USING btree ("origin") WHERE "app"."tenant_domains"."verified_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_domains_tenant_origin_idx" ON "app"."tenant_domains" USING btree ("tenant_id","origin");--> statement-breakpoint
CREATE INDEX "tenant_domains_tenant_idx" ON "app"."tenant_domains" USING btree ("tenant_id");