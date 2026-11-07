import { sql } from 'drizzle-orm';
import { index, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { app, id } from './base.js';
import { contacts } from './channel.js';
import { customerColumn, tenantColumn } from './tenancy.js';

/**
 * A person or an organisation a business works with who is not on its team: someone of a
 * customer's household, an outside organisation. Per business: the same organisation at two
 * businesses is two parties. What the application keeps about one (its own details, files) lives
 * in its tables, keyed by this id. Kind (`person` | `organisation`) is checked in
 * sql/post/parties.sql.
 */
export const parties = app.table(
  'parties',
  {
    id: id(),
    tenantId: tenantColumn(),
    kind: text('kind', { enum: ['person', 'organisation'] }).notNull(),
    name: text('name').notNull(),
    /** The customer record it belongs to: several people of one customer. */
    customerId: customerColumn(),
    /** The user who added it. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('parties_tenant_idx').on(table.tenantId, table.name),
    index('parties_customer_idx').on(table.tenantId, table.customerId),
  ],
);

/**
 * How a party is reached: a person with an account (who joined with an emailed link, the token's
 * SHA-256 kept until then), or the business's WhatsApp contact for a number. A row has a user, a
 * contact or a pending email (checked in sql/post/parties.sql). Never a membership of the business.
 */
export const partyMembers = app.table(
  'party_members',
  {
    id: id(),
    tenantId: tenantColumn(),
    partyId: text('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    /** What the business calls this person. */
    name: text('name'),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    /** An invitation's address (lower case), kept after it is accepted. */
    email: text('email'),
    tokenHash: text('token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    addedBy: text('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('party_members_user_idx')
      .on(table.partyId, table.userId)
      .where(sql`${table.userId} is not null`),
    uniqueIndex('party_members_contact_idx')
      .on(table.partyId, table.contactId)
      .where(sql`${table.contactId} is not null`),
    uniqueIndex('party_members_token_idx')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} is not null`),
    index('party_members_party_idx').on(table.partyId),
    // Who a person or a contact is a party member of: every participant query starts here.
    index('party_members_person_idx').on(table.userId, table.tenantId),
    index('party_members_contact_lookup_idx').on(table.contactId),
  ],
);

/**
 * A party on a record, in a participant role the application declares: what the `participant`
 * access grant finds. One (record, party, role) once.
 */
export const participations = app.table(
  'participations',
  {
    id: id(),
    tenantId: tenantColumn(),
    /** The record's entity name ('meeting'), as audited. */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    partyId: text('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    addedBy: text('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('participations_one_idx').on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.partyId,
      table.role,
    ),
    index('participations_party_idx').on(table.partyId),
  ],
);
