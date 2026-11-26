// The share feature's fixture table (B9): inquiries, which a public form creates, with a field
// only some roles read and the business's custom fields. Its own migration set (migrations/,
// `FIXTURE_FEATURE=share pnpm fixture:generate --name share`).
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, customFieldsColumn, id, tenantColumn, user } from '@hykr/db';
import { boolean, date, index, integer, text, timestamp } from 'drizzle-orm/pg-core';

export const inquiries = app.table(
  'fixture_inquiries',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    name: text('name').notNull(),
    topic: text('topic').notNull().default('general'),
    guests: integer('guests'),
    wanted: date('wanted'),
    notes: text('notes').notNull().default(''),
    urgent: boolean('urgent').notNull().default(false),
    /** Read only with fixture.inquiries.score. */
    score: integer('score'),
    source: text('source').notNull().default('team'),
    custom: customFieldsColumn(),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('fixture_inquiries_tenant_idx').on(t.tenantId)],
);
