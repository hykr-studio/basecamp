CREATE TABLE "app"."orders_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"parent_item_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"quantity" integer,
	"currency" text NOT NULL,
	"unit_price" bigint,
	"tax_rate_bp" integer,
	"amount" bigint DEFAULT 0 NOT NULL,
	"cost" bigint,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_items_order_id_uq" UNIQUE("order_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."orders" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"currency" text NOT NULL,
	"subtotal" bigint DEFAULT 0 NOT NULL,
	"tax_total" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"tax_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_number_uq" UNIQUE("tenant_id","number"),
	CONSTRAINT "orders_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."orders_items" ADD CONSTRAINT "orders_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders_items" ADD CONSTRAINT "orders_items_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders_items" ADD CONSTRAINT "orders_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders_items" ADD CONSTRAINT "orders_items_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "app"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders_items" ADD CONSTRAINT "orders_items_parent_fk" FOREIGN KEY ("order_id","parent_item_id") REFERENCES "app"."orders_items"("order_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_items_order_idx" ON "app"."orders_items" USING btree ("order_id","position");--> statement-breakpoint
CREATE INDEX "orders_tenant_customer_idx" ON "app"."orders" USING btree ("tenant_id","customer_id");