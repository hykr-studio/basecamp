CREATE TABLE "app"."meetings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"attendees" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"meeting_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."approvals" ALTER COLUMN "resource_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "requested_by" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "app"."approvals" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "app"."todos" ADD COLUMN "meeting_id" text;--> statement-breakpoint
ALTER TABLE "audit"."events" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "audit"."events" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD CONSTRAINT "notes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notes" ADD CONSTRAINT "notes_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "app"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_owner_starts_idx" ON "app"."meetings" USING btree ("owner_id","starts_at");--> statement-breakpoint
CREATE INDEX "notes_owner_created_idx" ON "app"."notes" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "notes_meeting_idx" ON "app"."notes" USING btree ("meeting_id");--> statement-breakpoint
ALTER TABLE "app"."todos" ADD CONSTRAINT "todos_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "app"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "todos_meeting_idx" ON "app"."todos" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "audit"."events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "events_request_idx" ON "audit"."events" USING btree ("request_id");