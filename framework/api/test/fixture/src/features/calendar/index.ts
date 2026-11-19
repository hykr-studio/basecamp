// Calendars and calls (B17), on neutral data: an `appointments` module whose records carry the
// schedulable trait (title, times, place, notes, and a second person), a read projector that
// hides an appointment's notes from staff, a telephony provider of the fixture's own with a
// signed sender for its status updates, and a handler that writes those updates as the system.
// Only the calendar test boots `calendarApp`.
import { callProviderUpdate, defineConnectorHandler, defineModule, defineServer } from '@hykr/api';
import { type DialRequest, defineTelephonyProvider, hmacConnector } from '@hykr/connectors';
import { CreatedBy, entitySpec, moduleSpec } from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers, type ReadProjector } from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { appointments } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const at = z.iso.datetime({ offset: true });
const Status = z.enum(['booked', 'cancelled']);

export const Appointment = z.object({
  id: z.string(),
  title,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  place: z.string().nullable(),
  // Optional: removed for staff (placeNotes below).
  notes: z.string().nullable().optional(),
  assigneeId: z.string().nullable(),
  status: Status,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const AppointmentSpec = entitySpec({
  name: 'appointment',
  label: 'appointment',
  description: 'Appointments: a title, a start and an end, a place, notes and a second person.',
  schemas: {
    read: Appointment,
    create: z.object({
      title,
      startsAt: at,
      endsAt: at,
      place: z.string().max(200).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      assigneeId: z.string().nullable().optional(),
    }),
    update: z.object({
      title: title.optional(),
      startsAt: at.optional(),
      endsAt: at.optional(),
      place: z.string().max(200).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      assigneeId: z.string().nullable().optional(),
      status: Status.optional(),
    }),
  },
  list: {
    filterable: { startsAt: 'date', status: 'enum' },
    sortable: ['startsAt', 'createdAt'],
    defaultSort: [['startsAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  fieldLabels: { startsAt: label('Starts'), endsAt: label('Ends'), place: label('Place') },
  traits: {
    schedulable: {
      title: 'title',
      startsAt: 'startsAt',
      endsAt: 'endsAt',
      location: 'place',
      description: 'notes',
      people: ['ownerId', 'assigneeId'],
      hiddenWhen: { field: 'status', in: ['cancelled'] },
    },
  },
});

const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const AppointmentDef = defineEntity(AppointmentSpec, {
  table: appointments,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

@Module({
  controllers: [entityController(AppointmentDef)],
  providers: [...entityHandlers(AppointmentDef)],
})
export class AppointmentsModule {}

export const appointmentsModule = defineModule({
  ...moduleSpec({
    name: 'appointments',
    entities: { appointments: AppointmentSpec },
    commands: [],
  }),
  server: AppointmentsModule,
  tables: { appointments },
});

/** Staff never see an appointment's notes, wherever one leaves the server. */
export const notesFromStaff: ReadProjector = {
  name: 'fixture.calendar-notes',
  project: (type, value, p) => {
    if (type !== 'appointment' || !p.roles?.includes('staff')) return value;
    const { notes: _notes, ...rest } = value;
    return rest;
  },
};

/* ── A telephony provider of the fixture's own ─────────────────────────────── */

/** What the provider was asked to dial, in order. */
export const dialled: { request: DialRequest; credentials: unknown }[] = [];

/** A number the provider refuses to call. */
export const REFUSED_NUMBER = '+10000000000';

export const fixturePhone = defineTelephonyProvider<{ secret: string }>({
  name: 'fixture-phone',
  label: label('Fixture phone'),
  connector: 'fixture-phone',
  dial: async (request, { credentials }) => {
    dialled.push({ request, credentials });
    if (request.to === REFUSED_NUMBER) throw new Error('The provider refused the number');
    return { externalId: `ext-${request.callId}`, status: 'ringing' };
  },
});

/** The provider's status updates: signed, `{ type: 'call.status', externalId, status, … }`. */
export const fixturePhoneSender = hmacConnector({
  name: 'fixture-phone',
  label: label('Fixture phone updates'),
  header: 'x-fixture-phone-signature',
  idHeader: 'x-fixture-phone-event',
});

const PhoneUpdate = z.object({
  externalId: z.string(),
  status: z.enum(['ringing', 'in_progress', 'completed', 'missed', 'failed']).optional(),
  durationS: z.number().int().optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const phoneStatus = defineConnectorHandler({
  name: 'fixture.phone-status',
  connector: 'fixture-phone',
  on: ['call.status'],
  handle: async (event, ctx) => {
    const u = PhoneUpdate.parse(event.data);
    await ctx.write(callProviderUpdate(), {
      provider: 'fixture-phone',
      externalId: u.externalId,
      ...(u.status ? { status: u.status } : {}),
      ...(u.durationS !== undefined ? { durationS: u.durationS } : {}),
      ...(u.direction ? { direction: u.direction } : {}),
      ...(u.from ? { from: u.from } : {}),
      ...(u.to ? { to: u.to } : {}),
    });
  },
});

/** The fixture plus appointments, the notes projector and the fixture's phone. */
export const calendarApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, appointmentsModule],
  contributes: {
    readProjectors: [notesFromStaff],
    telephonyProviders: [fixturePhone],
    connectors: [fixturePhoneSender],
    connectorHandlers: [phoneStatus],
  },
});
