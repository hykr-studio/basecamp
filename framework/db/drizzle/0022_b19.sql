CREATE TABLE "app"."platform_operators" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."platform_routed" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"router" text,
	"tenant_id" text,
	"status" text NOT NULL,
	"reason" text,
	"resource_type" text,
	"resource_id" text,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."platform_support_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"operator_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"access" text DEFAULT 'read' NOT NULL,
	"roles" text[] NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"minutes" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_expires_at" timestamp with time zone NOT NULL,
	"consented_by" text,
	"consented_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"declined_by" text,
	"declined_at" timestamp with time zone,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	"ended_how" text
);
--> statement-breakpoint
CREATE TABLE "app"."platform_support_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"grant_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit"."events" ADD COLUMN "on_behalf_of" text;--> statement-breakpoint
ALTER TABLE "app"."platform_operators" ADD CONSTRAINT "platform_operators_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."platform_routed" ADD CONSTRAINT "platform_routed_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."platform_support_grants" ADD CONSTRAINT "platform_support_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."platform_support_grants" ADD CONSTRAINT "platform_support_grants_operator_id_platform_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "app"."platform_operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."platform_support_grants" ADD CONSTRAINT "platform_support_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."platform_support_log" ADD CONSTRAINT "platform_support_log_grant_id_platform_support_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "app"."platform_support_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."platform_support_log" ADD CONSTRAINT "platform_support_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_operators_user_idx" ON "app"."platform_operators" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_routed_ref_idx" ON "app"."platform_routed" USING btree ("source","ref");--> statement-breakpoint
CREATE INDEX "platform_routed_at_idx" ON "app"."platform_routed" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "platform_routed_tenant_idx" ON "app"."platform_routed" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_support_grants_tenant_idx" ON "app"."platform_support_grants" USING btree ("tenant_id","requested_at");--> statement-breakpoint
CREATE INDEX "platform_support_grants_user_idx" ON "app"."platform_support_grants" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "platform_support_grants_operator_idx" ON "app"."platform_support_grants" USING btree ("operator_id","requested_at");--> statement-breakpoint
CREATE INDEX "platform_support_log_grant_idx" ON "app"."platform_support_log" USING btree ("grant_id","at");