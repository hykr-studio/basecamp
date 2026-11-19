CREATE TABLE "app"."integration_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connector" text NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"token_sealed" text,
	"held" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integration_oauth_states" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector" text NOT NULL,
	"connection_id" text,
	"label" text,
	"state_hash" text NOT NULL,
	"verifier_sealed" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integration_unrouted" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"connector" text NOT NULL,
	"account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD COLUMN "auth" text DEFAULT 'credentials' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD COLUMN "owner" text DEFAULT 'business' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD COLUMN "scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD COLUMN "expiry_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "app"."integration_inbound" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "app"."integration_inbound" ADD COLUMN "expanded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."integration_accounts" ADD CONSTRAINT "integration_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_accounts" ADD CONSTRAINT "integration_accounts_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_accounts_connection_uq" ON "app"."integration_accounts" USING btree ("connection_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_accounts_held_uq" ON "app"."integration_accounts" USING btree ("connector","account_id") WHERE "app"."integration_accounts"."held";--> statement-breakpoint
CREATE UNIQUE INDEX "integration_oauth_states_state_uq" ON "app"."integration_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "integration_oauth_states_expires_idx" ON "app"."integration_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_unrouted_event_uq" ON "app"."integration_unrouted" USING btree ("connector","external_id");--> statement-breakpoint
CREATE INDEX "integration_unrouted_received_idx" ON "app"."integration_unrouted" USING btree ("received_at");