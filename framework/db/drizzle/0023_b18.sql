CREATE TABLE "app"."privacy_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"intake" text NOT NULL,
	"requested_by_kind" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"note" text,
	"reason" text,
	"outcome" jsonb,
	"files" text[] DEFAULT '{}'::text[] NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"overdue_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"queues" text DEFAULT 'bull' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."privacy_requests" ADD CONSTRAINT "privacy_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_requests_tenant_idx" ON "app"."privacy_requests" USING btree ("tenant_id","status","received_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_subject_idx" ON "app"."privacy_requests" USING btree ("tenant_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_due_idx" ON "app"."privacy_requests" USING btree ("queues","due_at") WHERE "app"."privacy_requests"."status" in ('received', 'in_progress') and "app"."privacy_requests"."overdue_at" is null;