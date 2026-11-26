// References (V2), on neutral data: a `rooms` module whose bookings name a room. `roomId` is
// declared (`traits.references`), so every write that sets or changes it loads the room as the
// writer; `spareRoomId` is not, so only the database's key checks it. Staff read and write their
// own rooms and bookings; owners and admins all of the business's. The assistant's new bookings
// wait for the person; offline phones choose a new booking's id; `booking.move` changes the room
// through the repository. A booking's update and delete can be undone for a minute. Plans have
// revisions, and `plan.revise` may name another room for the next one; a public form makes a
// plan, its room typed as text, and a guest's plan would wait for the team (so it is refused,
// `guest_cannot_wait`) (V10). Only the references test boots this server (`referencesServer`).
import { defineModule, defineServer } from '@hykr/api';
import {
  CreatedBy,
  commandSpec,
  defineApprovalLevel,
  definePublicForm,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import {
  allow,
  atLevel,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  defineLevelRule,
  entityController,
  entityHandlers,
  reviseWithChildren,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { bookings, plans, rooms } from './schema.js';

const same = (en: string) => ({ en, hi: en, te: en });

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

export const Plan = z.object({
  id: z.string(),
  title,
  roomId: z.string().nullable(),
  version: z.number().int(),
  seriesId: z.string().nullable(),
  revision: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const PlanSpec = entitySpec({
  name: 'plan',
  label: 'plan',
  description: 'Plans: a title and the room, in revisions.',
  schemas: {
    read: Plan,
    // Text, so a public form may ask for it.
    create: z.object({ title, roomId: z.string().min(1).max(64).optional() }),
    update: z.object({ title: title.optional(), roomId: z.uuid().nullable().optional() }),
  },
  list,
  // A guest's plan (the public form's) would wait for the team.
  approval: { create: (p) => p.actor.kind === 'guest' },
  traits: { references: { roomId: 'room' }, versioned: { revisions: {} } },
});

export const RevisePlanSpec = commandSpec({
  name: 'plan.revise',
  description: 'Make the next revision of a plan, in the same room or another.',
  input: z.object({ planId: z.uuid(), roomId: z.uuid().nullable().optional() }),
  output: Plan,
  http: { method: 'POST', path: '/api/plans/:planId/revise' },
  expose: 'all',
  touches: ['plan'],
});

export const roomsSpec = moduleSpec({
  name: 'rooms',
  entities: { rooms: RoomSpec, bookings: BookingSpec, plans: PlanSpec },
  commands: [MoveBookingSpec, RevisePlanSpec],
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

export const PlanDef = defineEntity(PlanSpec, {
  table: plans,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

/** The next revision: the caller's room goes straight into the copy (`values`). */
export const RevisePlan = defineCommand(RevisePlanSpec, {
  resource: { type: 'plan', id: (input) => input.planId },
  load: (tx, p, input) => PlanDef.repo.get(tx, p, input.planId),
  authorize: () => allow('revise'),
  summarize: (_input, plan) => `Revise "${plan.title}" (v${plan.revision})`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const next = await reviseWithChildren(tx, principal, PlanDef, loaded, {
      via,
      values: input.roomId === undefined ? {} : { roomId: input.roomId },
    });
    return {
      value: PlanDef.toRead(next.row as typeof loaded, principal),
      touched: next.touched,
    };
  },
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
    entityController(PlanDef),
    commandController(MoveBooking),
    commandController(RevisePlan),
  ],
  providers: [
    ...entityHandlers(RoomDef),
    ...entityHandlers(BookingDef),
    ...entityHandlers(PlanDef),
    commandHandler(MoveBooking),
    commandHandler(RevisePlan),
  ],
})
class RoomsModule {}

export const roomsModule = defineModule({
  ...roomsSpec,
  server: RoomsModule,
  tables: { rooms, bookings, plans },
});

/** A public form that makes a plan, naming its room. */
export const PlanForm = definePublicForm({
  name: 'rooms.plan',
  entity: 'plan',
  label: same('Plan a room'),
  fields: ['title', 'roomId'],
});

/** A booking's change or removal runs, and can be undone for a minute. */
export const UndoableLevel = defineApprovalLevel({
  name: 'fixture_rooms_undoable',
  rank: 1,
  label: same('Undoable'),
  policy: { parks: false, undoMs: 60_000 },
});

export const BookingLevels = defineLevelRule({
  name: 'fixture.bookings',
  on: ['booking.update', 'booking.delete'],
  decide: () => atLevel(UndoableLevel.name, 'booking_undoable', 'It can be undone'),
});

/** The fixture with the rooms module. */
export const referencesServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, roomsModule],
  contributes: {
    publicForms: [PlanForm],
    approvalLevels: [UndoableLevel],
    levelRules: [BookingLevels],
  },
});
