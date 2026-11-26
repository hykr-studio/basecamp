// The offline feature's tables (its own migration set, migrations/ next to this file): jots, made
// on a device that may be offline, versioned, with a field only some people read. Generate with
// `FIXTURE_FEATURE=offline pnpm fixture:generate --name offline`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user, versionColumn } from '@hykr/db';
import { boolean, index, text, timestamp } from 'drizzle-orm/pg-core';

export const jots = app.table(
  'fixture_jots',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    /** Read only with fixture.jots.secret. */
    secret: text('secret'),
    /** Asked for review: a create waits for someone who reviews jots. */
    review: boolean('review').notNull().default(false),
    version: versionColumn(),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('fixture_jots_tenant_idx').on(t.tenantId)],
);
