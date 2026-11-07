// The acceptance feature's fixture table: agreements, with a state, a version and a field only
// some roles see. Its own migration set (migrations/,
// `FIXTURE_FEATURE=acceptance pnpm fixture:generate --name acceptance`).
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user, versionColumn } from '@hykr/db';
import { text, timestamp, unique } from 'drizzle-orm/pg-core';

export const agreements = app.table(
  'fixture_agreements',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    terms: text('terms').notNull().default(''),
    /** Seen only with fixture.agreements.margin. */
    margin: text('margin'),
    status: text('status').notNull().default('draft'),
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
  (t) => [unique('fixture_agreements_tenant_id_uq').on(t.tenantId, t.id)],
);
