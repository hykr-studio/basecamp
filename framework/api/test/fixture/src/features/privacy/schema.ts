// The privacy fixture's tables, in a migration set of their own (migrations/, next to this file):
// `FIXTURE_FEATURE=privacy pnpm fixture:generate --name privacy`. Import `app` from @hykr/db,
// never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { integer, text, timestamp } from 'drizzle-orm/pg-core';

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

/** Cards: a customer's name and phone (personal), and an amount (the business's). */
export const cards = app.table('fixture_ledgers_cards', {
  ...common(),
  name: text('name').notNull(),
  phone: text('phone'),
  amountMinor: integer('amount_minor').notNull().default(0),
});

/** Ledger entries: kept when their customer is forgotten (a legal hold). */
export const ledgerEntries = app.table('fixture_ledgers_entries', {
  ...common(),
  payer: text('payer').notNull(),
  amountMinor: integer('amount_minor').notNull().default(0),
});

/** Callers: a customer's or a WhatsApp contact's, anonymised when they are forgotten. */
export const callers = app.table('fixture_ledgers_callers', {
  ...common(),
  /** The contact who called (no foreign key: the contact goes first). */
  contactId: text('contact_id'),
  caller: text('caller').notNull(),
  phone: text('phone'),
});
