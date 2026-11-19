CREATE TABLE "app"."participations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"party_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."parties" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"customer_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."party_members" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"party_id" text NOT NULL,
	"name" text,
	"user_id" text,
	"contact_id" text,
	"email" text,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."participations" ADD CONSTRAINT "participations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."participations" ADD CONSTRAINT "participations_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "app"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."parties" ADD CONSTRAINT "parties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."parties" ADD CONSTRAINT "parties_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."party_members" ADD CONSTRAINT "party_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."party_members" ADD CONSTRAINT "party_members_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "app"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."party_members" ADD CONSTRAINT "party_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."party_members" ADD CONSTRAINT "party_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "channel"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "participations_one_idx" ON "app"."participations" USING btree ("tenant_id","resource_type","resource_id","party_id","role");--> statement-breakpoint
CREATE INDEX "participations_party_idx" ON "app"."participations" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "parties_tenant_idx" ON "app"."parties" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "parties_customer_idx" ON "app"."parties" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_members_user_idx" ON "app"."party_members" USING btree ("party_id","user_id") WHERE "app"."party_members"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "party_members_contact_idx" ON "app"."party_members" USING btree ("party_id","contact_id") WHERE "app"."party_members"."contact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "party_members_token_idx" ON "app"."party_members" USING btree ("token_hash") WHERE "app"."party_members"."token_hash" is not null;--> statement-breakpoint
CREATE INDEX "party_members_party_idx" ON "app"."party_members" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "party_members_person_idx" ON "app"."party_members" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "party_members_contact_lookup_idx" ON "app"."party_members" USING btree ("contact_id");