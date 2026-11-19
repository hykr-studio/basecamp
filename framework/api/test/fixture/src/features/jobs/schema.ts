// The jobs feature's fixture table: drawings, which a long-running job renders. Its own
// migration set (migrations/, `FIXTURE_FEATURE=jobs pnpm fixture:generate --name jobs`).
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, fileColumn, id, tenantColumn, user } from '@hykr/db';
import { integer, text, timestamp } from 'drizzle-orm/pg-core';

export const drawings = app.table('fixture_drawings', {
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  customerId: customerColumn(),
  title: text('title').notNull(),
  /** The first page of its latest render, put here by the render job's `complete`. */
  preview: fileColumn('preview'),
  /** How many pages its latest render had. */
  pages: integer('pages'),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
