// A fixture feature with a migration set of its own (migrations/, next to this file) and SQL
// hooks (sql/pre, sql/post): what each parallel feature does instead of adding to the fixture's
// single journal. Generate with `FIXTURE_FEATURE=par pnpm fixture:generate --name par`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, id } from '@hykr/db';
import { text, timestamp } from 'drizzle-orm/pg-core';

export const parNotes = app.table('fixture_par_notes', {
  id: id(),
  title: text('title').notNull(),
  // Filled by the trigger in sql/post, with the function from sql/pre.
  slug: text('slug'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
