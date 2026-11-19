CREATE TABLE "app"."fixture_sheets_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"cost" integer,
	CONSTRAINT "fixture_sheets_items_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."fixture_sheets_lines" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sheet_id" text NOT NULL,
	"parent_line_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"item_id" text,
	"alt_item_id" text,
	CONSTRAINT "fixture_sheets_lines_sheet_id_uq" UNIQUE("sheet_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."fixture_sheets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"series_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "fixture_sheets_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_items" ADD CONSTRAINT "fixture_sheets_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_items" ADD CONSTRAINT "fixture_sheets_items_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_items" ADD CONSTRAINT "fixture_sheets_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_lines" ADD CONSTRAINT "fixture_sheets_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_lines" ADD CONSTRAINT "fixture_sheets_lines_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_lines" ADD CONSTRAINT "fixture_sheets_lines_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_lines" ADD CONSTRAINT "fixture_sheets_lines_sheet_fk" FOREIGN KEY ("tenant_id","sheet_id") REFERENCES "app"."fixture_sheets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_lines" ADD CONSTRAINT "fixture_sheets_lines_parent_fk" FOREIGN KEY ("sheet_id","parent_line_id") REFERENCES "app"."fixture_sheets_lines"("sheet_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets_lines" ADD CONSTRAINT "fixture_sheets_lines_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "app"."fixture_sheets_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets" ADD CONSTRAINT "fixture_sheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets" ADD CONSTRAINT "fixture_sheets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_sheets" ADD CONSTRAINT "fixture_sheets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixture_sheets_lines_sheet_idx" ON "app"."fixture_sheets_lines" USING btree ("sheet_id","position");