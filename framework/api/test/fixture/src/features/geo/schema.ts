// The geo feature's tables (its own migration set, migrations/ next to this file): spots with a
// point and an address, and the arrivals people check in at them. Generate with
// `FIXTURE_FEATURE=geo pnpm fixture:generate --name geo`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import {
  addressColumn,
  app,
  customerColumn,
  geoIndex,
  geoPoint,
  id,
  tenantColumn,
  user,
} from '@hykr/db';
import { doublePrecision, index, integer, text, timestamp } from 'drizzle-orm/pg-core';

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

export const spots = app.table(
  'fixture_spots',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    location: geoPoint('location'),
    address: addressColumn('address'),
    /** How close an arrival must be, in metres. */
    radiusM: integer('radius_m').notNull().default(100),
    ...provenance(),
  },
  (t) => [geoIndex('fixture_spots_location_gist', t.location)],
);

export const spotArrivals = app.table(
  'fixture_spots_arrivals',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    spotId: text('spot_id')
      .notNull()
      .references(() => spots.id, { onDelete: 'cascade' }),
    location: geoPoint('location').notNull(),
    distanceM: doublePrecision('distance_m').notNull(),
    accuracyM: doublePrecision('accuracy_m'),
    ...provenance(),
  },
  (t) => [index('fixture_spots_arrivals_spot_idx').on(t.spotId)],
);
