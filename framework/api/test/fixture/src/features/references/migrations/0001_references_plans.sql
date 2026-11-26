CREATE TABLE "app"."fixture_rooms_plans" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"room_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"series_id" text,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_rooms_plans" ADD CONSTRAINT "fixture_rooms_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_rooms_plans" ADD CONSTRAINT "fixture_rooms_plans_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_rooms_plans" ADD CONSTRAINT "fixture_rooms_plans_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_rooms_plans" ADD CONSTRAINT "fixture_rooms_plans_room_id_fixture_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "app"."fixture_rooms"("id") ON DELETE set null ON UPDATE no action;