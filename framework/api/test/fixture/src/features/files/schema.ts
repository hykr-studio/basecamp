// The files feature's fixture table: cards with every kind of file field. Its own migration set
// (migrations/, `FIXTURE_FEATURE=files pnpm fixture:generate --name files`).
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, fileColumn, fileColumns, id, tenantColumn, user } from '@hykr/db';
import { text, timestamp } from 'drizzle-orm/pg-core';

export const cards = app.table('fixture_cards', {
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  customerId: customerColumn(),
  title: text('title').notNull(),
  /** One cover image. */
  cover: fileColumn('cover'),
  /** Up to three photos. */
  photos: fileColumns('photos'),
  /** Documents and voice notes. */
  attachments: fileColumns('attachments'),
  /** A file staff never see. */
  secret: fileColumn('secret'),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
