CREATE TABLE "app"."fixture_inquiries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"name" text NOT NULL,
	"topic" text DEFAULT 'general' NOT NULL,
	"guests" integer,
	"wanted" date,
	"notes" text DEFAULT '' NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"score" integer,
	"source" text DEFAULT 'team' NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_inquiries" ADD CONSTRAINT "fixture_inquiries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_inquiries" ADD CONSTRAINT "fixture_inquiries_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_inquiries" ADD CONSTRAINT "fixture_inquiries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixture_inquiries_tenant_idx" ON "app"."fixture_inquiries" USING btree ("tenant_id");