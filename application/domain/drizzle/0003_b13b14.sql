CREATE TABLE "app"."meetings_check_ins" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"customer_id" text,
	"meeting_id" text NOT NULL,
	"location" "geography" NOT NULL,
	"distance_m" double precision NOT NULL,
	"accuracy_m" double precision,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD COLUMN "address" jsonb;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD COLUMN "location" "geography";--> statement-breakpoint
ALTER TABLE "app"."meetings_check_ins" ADD CONSTRAINT "meetings_check_ins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings_check_ins" ADD CONSTRAINT "meetings_check_ins_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings_check_ins" ADD CONSTRAINT "meetings_check_ins_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings_check_ins" ADD CONSTRAINT "meetings_check_ins_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "app"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_check_ins_meeting_idx" ON "app"."meetings_check_ins" USING btree ("tenant_id","meeting_id");--> statement-breakpoint
CREATE INDEX "meetings_location_gist" ON "app"."meetings" USING gist ("location");