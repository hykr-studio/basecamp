// The documents feature's fixture table: memos, with a line and a picture only some roles see, and
// pictures for documents with images. Its own migration set (migrations/,
// `FIXTURE_FEATURE=documents pnpm fixture:generate --name documents`).
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, fileColumn, fileColumns, id, tenantColumn, user } from '@hykr/db';
import { text, timestamp } from 'drizzle-orm/pg-core';

export const memos = app.table('fixture_memos', {
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  customerId: customerColumn(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  /** Seen only with memos.secret.read. */
  secret: text('secret'),
  /** One picture, and a few more, for its photo sheet. */
  photo: fileColumn('photo'),
  photos: fileColumns('photos'),
  /** A picture seen only with memos.secret.read. */
  secretPhoto: fileColumn('secret_photo'),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
