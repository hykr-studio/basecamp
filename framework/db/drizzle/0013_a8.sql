CREATE TABLE "app"."memories" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"text" text NOT NULL,
	"created_by" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."memory_index" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"message_id" text,
	"subject" text,
	"about_type" text,
	"about_id" text,
	"model" text,
	"embedding" real[],
	"state" text DEFAULT 'pending' NOT NULL,
	"queues" text DEFAULT 'bull' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claim" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."memories" ADD CONSTRAINT "memories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memories" ADD CONSTRAINT "memories_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memory_index" ADD CONSTRAINT "memory_index_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memory_index" ADD CONSTRAINT "memory_index_message_id_thread_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."thread_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_tenant_updated_idx" ON "app"."memories" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "memories_owner_idx" ON "app"."memories" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_index_source_idx" ON "app"."memory_index" USING btree ("tenant_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "memory_index_search_idx" ON "app"."memory_index" USING btree ("tenant_id","model","kind");--> statement-breakpoint
CREATE INDEX "memory_index_about_idx" ON "app"."memory_index" USING btree ("tenant_id","about_type","about_id");--> statement-breakpoint
CREATE INDEX "memory_index_subject_idx" ON "app"."memory_index" USING btree ("tenant_id","subject");--> statement-breakpoint
CREATE INDEX "memory_index_pending_idx" ON "app"."memory_index" USING btree ("queues","updated_at") WHERE "app"."memory_index"."state" = 'pending';