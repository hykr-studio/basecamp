// The references feature's tables (its own migration set, migrations/ next to this file): rooms,
// and bookings that name a room. Generate with
// `FIXTURE_FEATURE=references pnpm fixture:generate --name references`.
// Import `app` from @hykr/db, never export it: an exported schema would be created again.
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { text, timestamp } from 'drizzle-orm/pg-core';

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

export const rooms = app.table('fixture_rooms', {
  ...common(),
  title: text('title').notNull(),
});

export const bookings = app.table('fixture_rooms_bookings', {
  ...common(),
  title: text('title').notNull(),
  /** Declared on the spec (`traits.references`): checked as the writer before every write. */
  roomId: text('room_id').references(() => rooms.id, { onDelete: 'set null' }),
  /** Not declared: only the database's key checks it, and a room it names cannot be deleted. */
  spareRoomId: text('spare_room_id').references(() => rooms.id),
});
