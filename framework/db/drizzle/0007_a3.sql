CREATE TABLE "app"."credit_alerts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"cap" text NOT NULL,
	"level" text NOT NULL,
	"used_percent" integer NOT NULL,
	"threshold" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."credit_ledger" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"currency" text NOT NULL,
	"ref" text,
	"note" text,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."credit_purchases" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"checkout_url" text,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."credit_wallets" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."usage_counters" (
	"tenant_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"meter" text NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_tenant_id_period_start_meter_pk" PRIMARY KEY("tenant_id","period_start","meter")
);
--> statement-breakpoint
CREATE TABLE "app"."usage_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"meter" text NOT NULL,
	"variant" text,
	"quantity" bigint NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"currency" text,
	"period_start" timestamp with time zone NOT NULL,
	"subject" text,
	"run_id" text,
	"channel" text,
	"source" text NOT NULL,
	"ref" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."credit_alerts" ADD CONSTRAINT "credit_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_ledger" ADD CONSTRAINT "credit_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_purchases" ADD CONSTRAINT "credit_purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_wallets" ADD CONSTRAINT "credit_wallets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_alerts_once_idx" ON "app"."credit_alerts" USING btree ("tenant_id","period_start","cap","level");--> statement-breakpoint
CREATE INDEX "credit_ledger_tenant_at_idx" ON "app"."credit_ledger" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "credit_purchases_tenant_idx" ON "app"."credit_purchases" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_ref_idx" ON "app"."usage_events" USING btree ("tenant_id","meter","ref") WHERE "app"."usage_events"."ref" is not null;--> statement-breakpoint
CREATE INDEX "usage_events_tenant_at_idx" ON "app"."usage_events" USING btree ("tenant_id","at");