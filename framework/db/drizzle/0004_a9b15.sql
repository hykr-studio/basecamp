CREATE TABLE "channel"."push_tickets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"send_id" text NOT NULL,
	"token" text NOT NULL,
	"receipt_id" text,
	"notification" text NOT NULL,
	"dedupe" text NOT NULL,
	"meta" jsonb,
	"status" text NOT NULL,
	"error" text,
	"queues" text DEFAULT 'bull' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel"."push_tokens" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel"."push_tickets" ADD CONSTRAINT "push_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."push_tickets" ADD CONSTRAINT "push_tickets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."push_tokens" ADD CONSTRAINT "push_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel"."push_tokens" ADD CONSTRAINT "push_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_tickets_pending_idx" ON "channel"."push_tickets" USING btree ("queues","status","created_at");--> statement-breakpoint
CREATE INDEX "push_tickets_send_idx" ON "channel"."push_tickets" USING btree ("send_id");--> statement-breakpoint
CREATE INDEX "push_tickets_user_idx" ON "channel"."push_tickets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_token_tenant_idx" ON "channel"."push_tokens" USING btree ("token","tenant_id");--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "channel"."push_tokens" USING btree ("tenant_id","user_id");