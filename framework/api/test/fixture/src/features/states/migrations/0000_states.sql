CREATE TABLE "app"."fixture_tickets_steps" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"parent_step_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"title" text NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixture_tickets_steps_ticket_id_uq" UNIQUE("ticket_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."fixture_tickets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"series_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixture_tickets_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets_steps" ADD CONSTRAINT "fixture_tickets_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets_steps" ADD CONSTRAINT "fixture_tickets_steps_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets_steps" ADD CONSTRAINT "fixture_tickets_steps_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets_steps" ADD CONSTRAINT "fixture_tickets_steps_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "app"."fixture_tickets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets_steps" ADD CONSTRAINT "fixture_tickets_steps_parent_fk" FOREIGN KEY ("ticket_id","parent_step_id") REFERENCES "app"."fixture_tickets_steps"("ticket_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets" ADD CONSTRAINT "fixture_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets" ADD CONSTRAINT "fixture_tickets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fixture_tickets" ADD CONSTRAINT "fixture_tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixture_tickets_steps_ticket_idx" ON "app"."fixture_tickets_steps" USING btree ("ticket_id","position");