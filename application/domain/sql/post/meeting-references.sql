-- A to-do's or a note's meeting is a meeting of its own business (V2, docs/decisions/V2.md). The
-- specs declare the reference (`traits.references`), which the write path checks as the writer;
-- this key is the database's backstop. It points (tenant_id, meeting_id) at the meeting's
-- (tenant_id, id) (unique in the meetings' schema), and a deleted meeting unlinks only its own
-- business's rows: SET NULL of meeting_id alone, which drizzle cannot say (Postgres 15+).
-- Before the key is added, once, a link to a missing meeting or to another business's is
-- removed: those should never have been stored. Every later migrate finds the key and skips.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'todos_meeting_fk') THEN
    UPDATE app.todos t SET meeting_id = NULL
      WHERE t.meeting_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM app.meetings m WHERE m.id = t.meeting_id AND m.tenant_id = t.tenant_id);
    ALTER TABLE app.todos ADD CONSTRAINT todos_meeting_fk
      FOREIGN KEY (tenant_id, meeting_id) REFERENCES app.meetings (tenant_id, id)
      ON DELETE SET NULL (meeting_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_meeting_fk') THEN
    UPDATE app.notes n SET meeting_id = NULL
      WHERE n.meeting_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM app.meetings m WHERE m.id = n.meeting_id AND m.tenant_id = n.tenant_id);
    ALTER TABLE app.notes ADD CONSTRAINT notes_meeting_fk
      FOREIGN KEY (tenant_id, meeting_id) REFERENCES app.meetings (tenant_id, id)
      ON DELETE SET NULL (meeting_id);
  END IF;
END $$;
