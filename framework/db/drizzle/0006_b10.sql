CREATE TABLE "app"."integration_attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"error" text,
	"duration_ms" integer,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integration_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"connector" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"credentials_sealed" text NOT NULL,
	"public" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integration_deliveries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"queues" text DEFAULT 'bull' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integration_endpoints" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"events" text[] NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"secret_sealed" text NOT NULL,
	"previous_secret_sealed" text,
	"previous_expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integration_inbound" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connector" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"handled" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"queues" text DEFAULT 'bull' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."integration_attempts" ADD CONSTRAINT "integration_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_attempts" ADD CONSTRAINT "integration_attempts_delivery_id_integration_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "app"."integration_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD CONSTRAINT "integration_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD CONSTRAINT "integration_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_deliveries" ADD CONSTRAINT "integration_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_deliveries" ADD CONSTRAINT "integration_deliveries_endpoint_id_integration_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "app"."integration_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_endpoints" ADD CONSTRAINT "integration_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_endpoints" ADD CONSTRAINT "integration_endpoints_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_inbound" ADD CONSTRAINT "integration_inbound_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_inbound" ADD CONSTRAINT "integration_inbound_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_attempts_delivery_idx" ON "app"."integration_attempts" USING btree ("delivery_id","attempt");--> statement-breakpoint
CREATE INDEX "integration_connections_tenant_idx" ON "app"."integration_connections" USING btree ("tenant_id","connector");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_deliveries_event_idx" ON "app"."integration_deliveries" USING btree ("endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "integration_deliveries_log_idx" ON "app"."integration_deliveries" USING btree ("tenant_id","endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_deliveries_due_idx" ON "app"."integration_deliveries" USING btree ("queues","status","next_attempt_at") WHERE "app"."integration_deliveries"."status" in ('pending', 'sending', 'retrying');--> statement-breakpoint
CREATE INDEX "integration_endpoints_tenant_idx" ON "app"."integration_endpoints" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_inbound_event_idx" ON "app"."integration_inbound" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "integration_inbound_log_idx" ON "app"."integration_inbound" USING btree ("tenant_id","connection_id","received_at");--> statement-breakpoint
CREATE INDEX "integration_inbound_pending_idx" ON "app"."integration_inbound" USING btree ("queues","received_at") WHERE "app"."integration_inbound"."status" = 'pending';