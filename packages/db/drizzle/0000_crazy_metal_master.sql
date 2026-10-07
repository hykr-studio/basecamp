CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."approvals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"owner_id" text NOT NULL,
	"action" text NOT NULL,
	"rule" text NOT NULL,
	"reason" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."idempotency" (
	"key" text NOT NULL,
	"principal_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_principal_id_pk" PRIMARY KEY("key","principal_id")
);
--> statement-breakpoint
CREATE TABLE "app"."todos" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"acting_for" text,
	"run_id" text,
	"agent_version" text,
	"rule" text,
	"reason" text,
	"outcome" text DEFAULT 'committed' NOT NULL,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD CONSTRAINT "approvals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."todos" ADD CONSTRAINT "todos_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "approvals_owner_status_idx" ON "app"."approvals" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "todos_owner_id_idx" ON "app"."todos" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "events_resource_idx" ON "audit"."events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "audit"."events" USING btree ("at");