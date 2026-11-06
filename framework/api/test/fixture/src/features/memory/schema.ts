// The memory fixture's tables, in a migration set of their own (migrations/, next to this file):
// `FIXTURE_FEATURE=memory pnpm fixture:generate --name memory`. Import `app` from @hykr/db, never
// export it: an exported schema would be created again.
import { app, id, tenantColumn, user } from '@hykr/db';
import { text, timestamp } from 'drizzle-orm/pg-core';

const common = () => ({
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/** Memos: memory of a task, with a field only some may read. */
export const memos = app.table('fixture_memos', {
  ...common(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  secret: text('secret'),
  /** The task it is memory of (no foreign key: the task may go first). */
  taskId: text('task_id'),
});

/** Asides: memory people may read, the assistant never. */
export const asides = app.table('fixture_memos_asides', {
  ...common(),
  title: text('title').notNull(),
});
