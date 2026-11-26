import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * A business's own field on one of its entities (A11): the `customField` entity. Values live in
 * that entity's `custom` jsonb column, checked against these on every write.
 */
export const customFields = app.table(
  'custom_fields',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** Who added it. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    /** The entity it belongs to, by name ('todo'). */
    entity: text('entity').notNull(),
    /** Its key in the `custom` object ('priority'). */
    key: text('key').notNull(),
    /** A custom field type ('select'). */
    type: text('type').notNull(),
    /** What people call it: Labels (English, and the application's other languages it has). */
    label: jsonb('label').notNull(),
    /** For a select: the values it may take. */
    options: jsonb('options').notNull().default([]),
    required: boolean('required').notNull().default(false),
    /** People and the assistant may filter lists on it. */
    filterable: boolean('filterable').notNull().default(true),
    position: integer('position').notNull().default(0),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('custom_fields_tenant_entity_key_idx').on(table.tenantId, table.entity, table.key),
  ],
);

/**
 * A web address a business serves its app on (A11, white label). Trusted for CORS and sign-in
 * only once `verifiedAt` is set: the business published the token in DNS. Several businesses may
 * claim an origin; the first to verify it holds it, so a pending claim cannot squat a domain.
 */
export const tenantDomains = app.table(
  'tenant_domains',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** An exact https origin: https://app.example.com */
    origin: text('origin').notNull(),
    /** The value the TXT record must hold. */
    token: text('token').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('tenant_domains_verified_origin_idx')
      .on(table.origin)
      .where(sql`${table.verifiedAt} is not null`),
    uniqueIndex('tenant_domains_tenant_origin_idx').on(table.tenantId, table.origin),
    index('tenant_domains_tenant_idx').on(table.tenantId),
  ],
);
