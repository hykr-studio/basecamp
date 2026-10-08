import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { contacts } from './channel.js';

/**
 * A business: everything people do happens in one. Every business row carries its tenantId,
 * and a principal works in exactly one tenant at a time.
 */
export const tenants = app.table('tenants', {
  id: id(),
  name: text('name').notNull(),
  /**
   * Who owns a record nobody on the staff made (a customer's booking on WhatsApp): it lands in
   * this person's lists, and they can hand it on.
   */
  defaultOwnerId: text('default_owner_id')
    .notNull()
    .references(() => user.id),
  /** How this business works on its channels (TenantSettings in @app/contracts). */
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** A person in a business, with their roles there (owner, admin, ops, staff, customer). */
export const memberships = app.table(
  'memberships',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
    /** Set when the person is this business's customer: their customer record. */
    customerId: text('customer_id'),
    /** The business a session works in unless it names another (x-tenant-id). */
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    uniqueIndex('memberships_one_default_idx').on(table.userId).where(sql`${table.isDefault}`),
  ],
);

/**
 * A customer of the business: a record, not a login. A WhatsApp contact and an app account
 * both point here, so a customer's bookings are theirs whichever way they came in.
 */
export const customers = app.table(
  'customers',
  {
    id: id(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    contactId: text('contact_id').references((): AnyPgColumn => contacts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('customers_user_idx')
      .on(table.tenantId, table.userId)
      .where(sql`${table.userId} is not null`),
    uniqueIndex('customers_contact_idx')
      .on(table.tenantId, table.contactId)
      .where(sql`${table.contactId} is not null`),
    index('customers_tenant_idx').on(table.tenantId),
  ],
);

/** The tenant a business row belongs to. Every business table has one. */
export const tenantColumn = () =>
  text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

/** The customer a row belongs to, when a customer made it or it is about them. */
export const customerColumn = () =>
  text('customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'set null' });
