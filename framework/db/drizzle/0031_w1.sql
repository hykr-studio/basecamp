CREATE TABLE "channel"."web_push_subscriptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel"."push_tickets" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "channel"."web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_tenant_idx" ON "channel"."web_push_subscriptions" USING btree ("endpoint","tenant_id");--> statement-breakpoint
CREATE INDEX "web_push_subscriptions_user_idx" ON "channel"."web_push_subscriptions" USING btree ("tenant_id","user_id");