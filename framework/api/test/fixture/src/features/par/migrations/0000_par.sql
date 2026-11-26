CREATE TABLE "app"."fixture_par_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"title" text NOT NULL,
	"slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
