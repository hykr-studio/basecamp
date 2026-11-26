CREATE TABLE "app"."fixture_issues" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" text,
	"title" text NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "app"."fixture_parts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shared_id" text,
	"title" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_issues" ADD CONSTRAINT "fixture_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_issues" ADD CONSTRAINT "fixture_issues_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_issues" ADD CONSTRAINT "fixture_issues_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_parts" ADD CONSTRAINT "fixture_parts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_parts" ADD CONSTRAINT "fixture_parts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fixture_parts_shared_idx" ON "app"."fixture_parts" USING btree ("tenant_id","shared_id");