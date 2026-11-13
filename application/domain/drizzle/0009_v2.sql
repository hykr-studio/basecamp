ALTER TABLE "app"."notes" DROP CONSTRAINT "notes_meeting_id_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."todos" DROP CONSTRAINT "todos_meeting_id_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_tenant_id_uq" UNIQUE("tenant_id","id");