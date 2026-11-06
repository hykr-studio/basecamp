CREATE TABLE "app"."fixture_baskets_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"basket_id" text NOT NULL,
	"parent_item_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"title" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"currency" text NOT NULL,
	"price" bigint,
	"cost" bigint,
	"amount" bigint DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixture_baskets_items_basket_id_uq" UNIQUE("basket_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."fixture_baskets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"number" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"currency" text NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"tax_total" bigint DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixture_baskets_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "fixture_baskets_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets_items" ADD CONSTRAINT "fixture_baskets_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets_items" ADD CONSTRAINT "fixture_baskets_items_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets_items" ADD CONSTRAINT "fixture_baskets_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets_items" ADD CONSTRAINT "fixture_baskets_items_basket_fk" FOREIGN KEY ("tenant_id","basket_id") REFERENCES "app"."fixture_baskets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets_items" ADD CONSTRAINT "fixture_baskets_items_parent_fk" FOREIGN KEY ("basket_id","parent_item_id") REFERENCES "app"."fixture_baskets_items"("basket_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets" ADD CONSTRAINT "fixture_baskets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets" ADD CONSTRAINT "fixture_baskets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_baskets" ADD CONSTRAINT "fixture_baskets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixture_baskets_items_basket_idx" ON "app"."fixture_baskets_items" USING btree ("basket_id","position");