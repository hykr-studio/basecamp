CREATE SCHEMA "channel";
--> statement-breakpoint
CREATE TABLE "channel"."contacts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"address" text NOT NULL,
	"profile_name" text,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"user_id" text,
	"customer_id" text,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."customers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"user_id" text,
	"contact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."memberships" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"customer_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."tenants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"default_owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."approvals" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."threads" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "requester_contact_id" text;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "approver_user_id" text;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "approver_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "approver_channels" text[];--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "min_assurance" text;--> statement-breakpoint
ALTER TABLE "app"."channel_links" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "app"."pages" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD COLUMN "contact_id" text;--> statement-breakpoint
ALTER TABLE "audit"."events" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "audit"."events" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "app"."todos" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "app"."todos" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "channel"."contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."contacts" ADD CONSTRAINT "contacts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tenants" ADD CONSTRAINT "tenants_default_owner_id_user_id_fk" FOREIGN KEY ("default_owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_address_idx" ON "channel"."contacts" USING btree ("tenant_id","channel","address");--> statement-breakpoint
CREATE INDEX "contacts_user_idx" ON "channel"."contacts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_user_idx" ON "app"."customers" USING btree ("tenant_id","user_id") WHERE "app"."customers"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_contact_idx" ON "app"."customers" USING btree ("tenant_id","contact_id") WHERE "app"."customers"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "customers_tenant_idx" ON "app"."customers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_default_idx" ON "app"."memberships" USING btree ("user_id") WHERE "app"."memberships"."is_default";--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_links" ADD CONSTRAINT "channel_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pages" ADD CONSTRAINT "pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD CONSTRAINT "notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD CONSTRAINT "notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."todos" ADD CONSTRAINT "todos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."todos" ADD CONSTRAINT "todos_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_tenant_status_idx" ON "app"."approvals" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "threads_contact_updated_idx" ON "app"."threads" USING btree ("contact_id","updated_at");--> statement-breakpoint
CREATE INDEX "events_tenant_at_idx" ON "audit"."events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "meetings_tenant_customer_idx" ON "app"."meetings" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "notes_tenant_customer_idx" ON "app"."notes" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "todos_tenant_customer_idx" ON "app"."todos" USING btree ("tenant_id","customer_id");--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_one_subject" CHECK (("app"."threads"."owner_id" is null) <> ("app"."threads"."contact_id" is null));