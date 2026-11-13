// Places on the map (B13), on neutral data: a `spots` module whose spots keep a point and an
// address, listed near a point or in a box and sorted by distance, and an `arrive` command that
// takes a check-in only within the spot's radius (`withinMeters`). A read projector hides a
// spot's point and address from staff. Only the geo test boots this server (`geoApp`).
import { defineModule, defineServer } from '@hykr/api';
import { Address, CreatedBy, commandSpec, entitySpec, GeoPoint, moduleSpec } from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  deny,
  entityController,
  entityHandlers,
  needsApproval,
  type ReadProjector,
  withinMeters,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { spotArrivals, spots } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const radiusM = z.number().int().min(1).max(100_000);

export const Spot = z.object({
  id: z.string(),
  title,
  // Optional: removed for whoever may not read them.
  location: GeoPoint.nullable().optional(),
  address: Address.nullable().optional(),
  radiusM: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const SpotSpec = entitySpec({
  name: 'spot',
  label: 'spot',
  description: 'Spots: a title, a point on the map and an address.',
  schemas: {
    read: Spot,
    create: z.object({
      title,
      location: GeoPoint.nullable().optional(),
      address: Address.nullable().optional(),
      radiusM: radiusM.optional(),
    }),
    update: z.object({
      title: title.optional(),
      location: GeoPoint.nullable().optional(),
      address: Address.nullable().optional(),
      radiusM: radiusM.optional(),
    }),
  },
  list: {
    filterable: { location: 'geo', title: 'text' },
    sortable: ['location', 'createdAt'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  approval: { delete: (p) => p.actor.kind === 'agent' },
  fieldLabels: { location: label('Place'), address: label('Address') },
});

export const SpotArrival = z.object({
  id: z.string(),
  spotId: z.string(),
  location: GeoPoint,
  distanceM: z.number(),
  accuracyM: z.number().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const SpotArrivalSpec = entitySpec({
  name: 'spotArrival',
  label: 'arrival',
  description: 'Check-ins at a spot, with where they were taken and how far from the spot.',
  schemas: {
    read: SpotArrival,
    create: z.object({
      spotId: z.string(),
      location: GeoPoint,
      distanceM: z.number().min(0),
      accuracyM: z.number().min(0).nullable().optional(),
    }),
    update: z.object({ accuracyM: z.number().min(0).nullable().optional() }),
  },
  list: {
    filterable: { spotId: 'id', location: 'geo' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  // Arrivals are taken only through `spot.arrive`, which measures them.
  expose: { list: 'all', get: 'all', create: 'internal', update: 'internal', delete: 'internal' },
});

export const ArriveInput = z.object({
  spotId: z.uuid(),
  at: GeoPoint,
  /** How far off the device says its fix may be, in metres. */
  accuracyM: z.number().min(0).max(100_000).optional(),
});

export const ArriveSpec = commandSpec({
  name: 'spot.arrive',
  description: 'Check in at a spot: only within its radius of the spot, with a precise enough fix.',
  input: ArriveInput,
  output: SpotArrival,
  http: { method: 'POST', path: '/api/spots/:spotId/arrive' },
  tool: 'arrive-at-spot',
  expose: 'all',
  touches: ['spotArrival'],
});

const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

/** Staff see every spot of the business (not where it is) and check in at it. */
const SPOT_ACCESS: Access = {
  read: { ...ACCESS.read, owner: 'tenant', staff: 'tenant' },
  write: ACCESS.write,
};

export const SpotDef = defineEntity(SpotSpec, {
  table: spots,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: SPOT_ACCESS,
});

export const SpotArrivalDef = defineEntity(SpotArrivalSpec, {
  table: spotArrivals,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  rules: [
    (_p, action, _row, _input, ctx) =>
      action === 'create' && ctx.via !== 'spot.arrive'
        ? deny('arrive_through_command', 'Check in with spot.arrive')
        : null,
  ],
});

export const Arrive = defineCommand(ArriveSpec, {
  resource: { type: 'spot', id: (input) => input.spotId },
  // The spot through its scoped repository (404 if not theirs), and the distance measured here,
  // in the transaction, the way the `near` filter measures.
  load: async (tx, p, input) => {
    const spot = await SpotDef.repo.get(tx, p, input.spotId);
    const fence = spot.location
      ? await withinMeters(tx, input.at, spot.location, spot.radiusM)
      : null;
    return { spot, fence };
  },
  authorize: (p, { spot, fence }, input) => {
    if (!fence) return deny('no_place', `${spot.title} has no place on the map`);
    if ((input.accuracyM ?? 0) > spot.radiusM)
      return deny(
        'imprecise_location',
        `Your position is only good to ${Math.round(input.accuracyM ?? 0)} m; ${spot.title} needs ${spot.radiusM} m`,
      );
    if (!fence.inside)
      return deny(
        'outside_geofence',
        `You are ${Math.round(fence.distanceM)} m from ${spot.title}; check in within ${spot.radiusM} m`,
      );
    return p.actor.kind === 'agent'
      ? needsApproval('agent_arrives', 'Check-ins by the assistant need approval')
      : allow('within_geofence');
  },
  summarize: (_input, { spot }) => `Check in at ${spot.title}`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const arrival = await SpotArrivalDef.repo.insert(
      tx,
      principal,
      {
        spotId: loaded.spot.id,
        location: input.at,
        distanceM: loaded.fence?.distanceM ?? 0,
        accuracyM: input.accuracyM ?? null,
      },
      via,
    );
    return {
      value: arrival,
      touched: [{ type: 'spotArrival', id: arrival.id, change: 'created', after: arrival }],
    };
  },
});

@Module({
  controllers: [
    commandController(Arrive),
    entityController(SpotDef),
    entityController(SpotArrivalDef),
  ],
  providers: [
    ...entityHandlers(SpotDef),
    ...entityHandlers(SpotArrivalDef),
    commandHandler(Arrive),
  ],
})
export class SpotsModule {}

export const spotsModule = defineModule({
  ...moduleSpec({
    name: 'spots',
    entities: { spots: SpotSpec, spotArrivals: SpotArrivalSpec },
    commands: [ArriveSpec],
  }),
  server: SpotsModule,
  tables: { spots, spotArrivals },
});

/** Staff never see where a spot is, wherever one leaves the server. */
export const placeFromStaff: ReadProjector = {
  name: 'fixture.geo-place',
  project: (type, value, p) => {
    if (type !== 'spot' || !p.roles?.includes('staff')) return value;
    const { location: _location, address: _address, ...rest } = value;
    return rest;
  },
};

/** The fixture plus spots. */
export const geoApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, spotsModule],
  contributes: { readProjectors: [placeFromStaff] },
});
