// References (V2), on neutral data: a `rooms` module whose bookings name a room. `roomId` is
// declared (`traits.references`), so every write that sets or changes it loads the room as the
// writer; `spareRoomId` is not, so only the database's key checks it. Staff read and write their
// own rooms and bookings; owners and admins all of the business's. The assistant's new bookings
// wait for the person; offline phones choose a new booking's id; `booking.move` changes the room
// through the repository. Only the references test boots this server (`referencesServer`).
import { defineModule, defineServer } from '@hykr/api';
import { CreatedBy, commandSpec, entitySpec, moduleSpec } from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  entityController,
  entityHandlers,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { bookings, rooms } from './schema.js';

const title = z.string().min(1).max(200);
const list = {
  filterable: { title: 'text' },
  sortable: ['createdAt'],
  defaultSort: [['createdAt', 'asc']],
  pageSize: { default: 50, max: 100 },
} as const satisfies Parameters<typeof entitySpec>[0]['list'];

export const Room = z.object({
  id: z.string(),
  title,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const RoomSpec = entitySpec({
  name: 'room',
  label: 'room',
  description: 'Rooms: a title.',
  schemas: {
    read: Room,
    create: z.object({ title }),
    update: z.object({ title: title.optional() }),
  },
  list,
});

export const Booking = z.object({
  id: z.string(),
  title,
  roomId: z.string().nullable(),
  spareRoomId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const BookingSpec = entitySpec({
  name: 'booking',
  label: 'booking',
  description: 'Bookings: a title, the room booked and a spare room.',
  schemas: {
    read: Booking,
    create: z.object({
      title,
      roomId: z.uuid().optional(),
      spareRoomId: z.uuid().optional(),
    }),
    update: z.object({
      title: title.optional(),
      roomId: z.uuid().nullable().optional(),
      spareRoomId: z.uuid().nullable().optional(),
    }),
  },
  list: { ...list, filterable: { title: 'text', roomId: 'id' } as const },
  // The assistant's new bookings wait for the person.
  approval: { create: (p) => p.actor.kind === 'agent' },
  traits: { references: { roomId: 'room' }, offline: {} },
});

export const MoveBookingSpec = commandSpec({
  name: 'booking.move',
  description: 'Move a booking to another room, or to none.',
  input: z.object({ bookingId: z.uuid(), roomId: z.uuid().nullable() }),
  output: Booking,
  http: { method: 'POST', path: '/api/bookings/:bookingId/move' },
  tool: 'move-booking',
  expose: 'all',
  verb: { do: 'move', did: 'moved' },
  touches: ['booking'],
});

export const roomsSpec = moduleSpec({
  name: 'rooms',
  entities: { rooms: RoomSpec, bookings: BookingSpec },
  commands: [MoveBookingSpec],
});

const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const RoomDef = defineEntity(RoomSpec, {
  table: rooms,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

export const BookingDef = defineEntity(BookingSpec, {
  table: bookings,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

export const MoveBooking = defineCommand(MoveBookingSpec, {
  resource: { type: 'booking', id: (input) => input.bookingId },
  load: (tx, p, input) => BookingDef.repo.get(tx, p, input.bookingId),
  authorize: () => allow('move'),
  summarize: (input) => `Move the booking to ${input.roomId ?? 'no room'}`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const after = await BookingDef.repo.update(
      tx,
      principal,
      loaded,
      { roomId: input.roomId },
      via,
    );
    return {
      value: BookingDef.toRead(after, principal),
      touched: [{ type: 'booking', id: after.id, change: 'updated', before: loaded, after }],
    };
  },
});

@Module({
  controllers: [
    entityController(RoomDef),
    entityController(BookingDef),
    commandController(MoveBooking),
  ],
  providers: [
    ...entityHandlers(RoomDef),
    ...entityHandlers(BookingDef),
    commandHandler(MoveBooking),
  ],
})
class RoomsModule {}

export const roomsModule = defineModule({
  ...roomsSpec,
  server: RoomsModule,
  tables: { rooms, bookings },
});

/** The fixture with the rooms module. */
export const referencesServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, roomsModule],
});
