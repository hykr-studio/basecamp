CREATE TABLE "app"."fixture_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"title" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"margin" integer,
	"booked_at" timestamp with time zone,
	"due_on" date,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_entries" ADD CONSTRAINT "fixture_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_entries" ADD CONSTRAINT "fixture_entries_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_entries" ADD CONSTRAINT "fixture_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixture_entries_tenant_state_idx" ON "app"."fixture_entries" USING btree ("tenant_id","state");