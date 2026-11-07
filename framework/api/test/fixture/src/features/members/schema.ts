// The members feature's fixture tables (A4): projects with a cost only some roles see, and their
// steps, which follow a project's grants. Generate with
// `FIXTURE_FEATURE=members pnpm fixture:generate --name members`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { index, integer, text, timestamp } from 'drizzle-orm/pg-core';

const common = () => ({
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  customerId: customerColumn(),
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const projects = app.table('fixture_projects', {
  ...common(),
  title: text('title').notNull(),
  /** Minor units of the business's currency: only some roles see it. */
  cost: integer('cost'),
});

export const projectSteps = app.table(
  'fixture_projects_steps',
  {
    ...common(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
  },
  (table) => [index('fixture_projects_steps_project_idx').on(table.projectId)],
);
