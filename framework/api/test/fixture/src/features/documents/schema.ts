// The documents feature's fixture table: memos, with a field only some roles see. Its own
// migration set (migrations/, `FIXTURE_FEATURE=documents pnpm fixture:generate --name documents`).
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
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
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
