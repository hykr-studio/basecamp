CREATE TABLE "app"."share_sends" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"link_id" text NOT NULL,
	"recipient" jsonb NOT NULL,
	"channel" text,
	"address" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"message_id" text,
	"error" text,
	"requested_by" text,
	"token_sealed" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."share_links" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."share_sends" ADD CONSTRAINT "share_sends_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_sends" ADD CONSTRAINT "share_sends_link_id_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "app"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_sends" ADD CONSTRAINT "share_sends_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "channel"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."share_sends" ADD CONSTRAINT "share_sends_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_sends_link_idx" ON "app"."share_sends" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "share_sends_status_idx" ON "app"."share_sends" USING btree ("status");