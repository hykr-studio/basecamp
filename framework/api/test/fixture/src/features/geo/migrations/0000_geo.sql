CREATE TABLE "app"."fixture_spots_arrivals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"spot_id" text NOT NULL,
	"location" "geography" NOT NULL,
	"distance_m" double precision NOT NULL,
	"accuracy_m" double precision,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."fixture_spots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"title" text NOT NULL,
	"location" "geography",
	"address" jsonb,
	"radius_m" integer DEFAULT 100 NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_spots_arrivals" ADD CONSTRAINT "fixture_spots_arrivals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_spots_arrivals" ADD CONSTRAINT "fixture_spots_arrivals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_spots_arrivals" ADD CONSTRAINT "fixture_spots_arrivals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_spots_arrivals" ADD CONSTRAINT "fixture_spots_arrivals_spot_id_fixture_spots_id_fk" FOREIGN KEY ("spot_id") REFERENCES "app"."fixture_spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_spots" ADD CONSTRAINT "fixture_spots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_spots" ADD CONSTRAINT "fixture_spots_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_spots" ADD CONSTRAINT "fixture_spots_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixture_spots_arrivals_spot_idx" ON "app"."fixture_spots_arrivals" USING btree ("spot_id");--> statement-breakpoint
CREATE INDEX "fixture_spots_location_gist" ON "app"."fixture_spots" USING gist ("location");