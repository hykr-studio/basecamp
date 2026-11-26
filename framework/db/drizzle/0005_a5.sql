CREATE TABLE "app"."undo_windows" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"touched" jsonb NOT NULL,
	"event_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"request_id" text,
	"until" timestamp with time zone NOT NULL,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "approver_capability" text;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "level" text;--> statement-breakpoint
ALTER TABLE "app"."undo_windows" ADD CONSTRAINT "undo_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."undo_windows" ADD CONSTRAINT "undo_windows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "undo_windows_user_idx" ON "app"."undo_windows" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "undo_windows_until_idx" ON "app"."undo_windows" USING btree ("until");