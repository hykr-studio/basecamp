CREATE TABLE "app"."number_series" (
	"tenant_id" text NOT NULL,
	"series" text NOT NULL,
	"period" text NOT NULL,
	"last" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_tenant_id_series_period_pk" PRIMARY KEY("tenant_id","series","period")
);
--> statement-breakpoint
ALTER TABLE "app"."number_series" ADD CONSTRAINT "number_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;