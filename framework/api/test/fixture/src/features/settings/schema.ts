// The settings feature's fixture tables (A11), in their own migration set:
// `FIXTURE_FEATURE=settings pnpm fixture:generate --name settings`. Import `app`, never export it.
import { app, customFieldsColumn, id, sharedFromColumn, tenantColumn, user } from '@hykr/db';
import { index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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

/** Gadgets: custom fields, and shared from the platform's business. */
export const gadgets = app.table(
  'fixture_gadgets',
  {
    ...common(),
    title: text('title').notNull(),
    rank: integer('rank').notNull().default(0),
    custom: customFieldsColumn(),
    sharedId: sharedFromColumn(),
  },
  (t) => [
    uniqueIndex('fixture_gadgets_tenant_shared_idx').on(t.tenantId, t.sharedId),
    index('fixture_gadgets_tenant_idx').on(t.tenantId),
  ],
);

/** Extras: a module a feature flag switches off as a whole. */
export const extras = app.table('fixture_extras', {
  ...common(),
  title: text('title').notNull(),
});
