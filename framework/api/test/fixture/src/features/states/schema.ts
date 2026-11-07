// The states feature's tables (its own migration set, migrations/ next to this file): tickets
// with a state, a version and revisions, and a tree of steps under each. Generate with
// `FIXTURE_FEATURE=states pnpm fixture:generate --name states`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import {
  app,
  customerColumn,
  id,
  revisionColumns,
  tenantColumn,
  user,
  versionColumn,
} from '@hykr/db';
import {
  type AnyPgColumn,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const provenance = () => ({
  createdBy: text('created_by', { enum: ['person', 'assistant'] })
    .notNull()
    .default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const tickets = app.table(
  'fixture_tickets',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    /** Its state: the tickets' state machine moves it, never plain CRUD. */
    status: text('status').notNull().default('open'),
    resolution: text('resolution'),
    /** Read only with fixture.tickets.notes. */
    note: text('note'),
    version: versionColumn(),
    ...revisionColumns(),
    ...provenance(),
  },
  (t) => [unique('fixture_tickets_tenant_id_uq').on(t.tenantId, t.id)],
);

export const ticketSteps = app.table(
  'fixture_tickets_steps',
  {
    id: id(),
    tenantId: tenantColumn(),
    ticketId: text('ticket_id').notNull(),
    parentStepId: text('parent_step_id'),
    position: integer('position').notNull().default(0),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    ...provenance(),
  },
  (t) => [
    unique('fixture_tickets_steps_ticket_id_uq').on(t.ticketId, t.id),
    foreignKey({
      name: 'fixture_tickets_steps_ticket_fk',
      columns: [t.tenantId, t.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fixture_tickets_steps_parent_fk',
      columns: [t.ticketId, t.parentStepId],
      foreignColumns: [t.ticketId, t.id] as [AnyPgColumn, AnyPgColumn],
    }).onDelete('cascade'),
    index('fixture_tickets_steps_ticket_idx').on(t.ticketId, t.position),
  ],
);
