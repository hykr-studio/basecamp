import {
  Address,
  addressText,
  distanceMeters,
  entitySpec,
  GeoPoint,
  listInputSchema,
  listQuerySchema,
  toQueryString,
} from '@hykr/contracts';
import { geoPoint, readEwkbPoint } from '@hykr/db';
import { BadRequestException } from '@nestjs/common';
import { and } from 'drizzle-orm';
import { PgDialect, pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import './geo.js';
import { buildListSql, decodeCursor, encodeCursor } from './list-grammar.js';

// A place entity with no domain: a title and a point.
const places = pgSchema('app').table('places', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  location: geoPoint('location'),
});
const Place = z.object({ id: z.string(), title: z.string(), location: GeoPoint.nullable() });
const PlaceSpec = entitySpec({
  name: 'place',
  label: 'place',
  description: 'Test places.',
  schemas: { read: Place, create: Place.omit({ id: true }), update: Place.partial() },
  list: {
    filterable: { location: 'geo', title: 'text' },
    sortable: ['location', 'title'],
    defaultSort: [['title', 'asc']],
    pageSize: { default: 20, max: 100 },
  },
});

const dialect = new PgDialect();
const render = (sql: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(sql);
const json = (input: object) => listInputSchema(PlaceSpec).safeParse(input);
const http = (input: object) => listQuerySchema(PlaceSpec).safeParse(input);
const HERE = { lat: 12.9716, lng: 77.5946 };

describe('the geo grammar', () => {
  it('near and within, as JSON', () => {
    const near = json({ location: { near: { ...HERE, radiusM: 500 } } });
    expect(near.success && near.data.filters).toEqual([
      { field: 'location', op: 'near', value: { ...HERE, radiusM: 500 } },
    ]);
    const within = json({ location: { within: { south: 1, west: 2, north: 3, east: 4 } } });
    expect(within.success && within.data.filters[0].value).toEqual({
      south: 1,
      west: 2,
      north: 3,
      east: 4,
    });
  });

  it('near and within, from a query string: comma lists or JSON', () => {
    const near = http({ 'location[near]': '12.9716, 77.5946, 500' });
    expect(near.success && near.data.filters[0].value).toEqual({ ...HERE, radiusM: 500 });
    const asJson = http({ 'location[near]': JSON.stringify({ ...HERE, radiusM: 50 }) });
    expect(asJson.success && asJson.data.filters[0].value).toEqual({ ...HERE, radiusM: 50 });
    const within = http({ 'location[within]': '12.9,77.5,13.1,77.7' });
    expect(within.success && within.data.filters[0].value).toEqual({
      south: 12.9,
      west: 77.5,
      north: 13.1,
      east: 77.7,
    });
  });

  it('refuses what it cannot measure', () => {
    for (const bad of [
      { location: { near: { ...HERE, radiusM: 0 } } },
      { location: { near: { ...HERE, radiusM: 30_000_000 } } },
      { location: { near: { lat: 91, lng: 0, radiusM: 5 } } },
      { location: { near: { ...HERE, radiusM: 5, extra: 1 } } },
      { location: { within: { south: 3, west: 2, north: 1, east: 4 } } },
      { location: { within: { south: 1, west: 170, north: 3, east: -170 } } },
      { location: HERE },
      { location: { eq: HERE } },
    ])
      expect(json(bad).success, JSON.stringify(bad)).toBe(false);
    for (const bad of [
      { 'location[near]': '1,2' },
      { 'location[near]': '1,2,x' },
      { 'location[near]': '1,,3' },
      { 'location[within]': '1,2,3' },
      { 'location[near]': '{bad json' },
    ])
      expect(http(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('toQueryString sends an object value as JSON, which the grammar reads back', () => {
    const qs = toQueryString({ location: { near: { ...HERE, radiusM: 500 } }, title: 'x' });
    const params = Object.fromEntries(new URLSearchParams(qs.slice(1)));
    expect(params).toEqual({
      'location[near]': JSON.stringify({ ...HERE, radiusM: 500 }),
      title: 'x',
    });
    const back = http(params);
    expect(back.success && back.data.filters).toEqual([
      { field: 'location', op: 'near', value: { ...HERE, radiusM: 500 } },
      { field: 'title', op: 'eq', value: 'x' },
    ]);
    expect(toQueryString({ ids: ['a', 'b'] })).toBe('?ids=a%2Cb');
  });
});

describe('the geo SQL', () => {
  it('near is ST_DWithin on geography; within a box is ST_Intersects', () => {
    const q = listInputSchema(PlaceSpec).parse({
      location: {
        near: { ...HERE, radiusM: 500 },
        within: { south: 1, west: 2, north: 3, east: 4 },
      },
    });
    const where = render(and(...buildListSql(places, PlaceSpec.list, q).where) as never);
    expect(where.sql).toContain(
      'ST_DWithin("app"."places"."location", ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography, $3::float8)',
    );
    expect(where.sql).toContain(
      'ST_Intersects("app"."places"."location", ST_MakeEnvelope($4::float8, $5::float8, $6::float8, $7::float8, 4326)::geography)',
    );
    // Longitude first, as PostGIS orders x and y.
    expect(where.params).toEqual([HERE.lng, HERE.lat, 500, 2, 1, 4, 3]);
  });

  it('a point field sorts by distance to its near point, with keyset cursors', () => {
    const q = listInputSchema(PlaceSpec).parse({
      location: { near: { ...HERE, radiusM: 5000 } },
      sort: '-location',
    });
    const built = buildListSql(places, PlaceSpec.list, q);
    const order = built.orderBy.map((o) => render(o).sql).join(', ');
    expect(order).toMatch(/^coalesce\(ST_Distance\("app"."places"."location", ST_SetSRID/);
    expect(order).toMatch(/desc, "app"."places"."id" asc$/);
    // A cursor keeps the row's point and compares distances computed the same way.
    const point = { lat: 13, lng: 77.6 };
    expect(built.cursorValues({ id: 'a', location: point })).toEqual([point]);
    const cursor = decodeCursor(encodeCursor(q.sort, [point], 'a'), q.sort);
    const after = render(built.after(cursor));
    expect(after.sql).toContain('< ST_Distance(ST_SetSRID(ST_MakePoint(');
    expect(after.params).toContain(77.6);
  });

  it('sorting by a point without a near filter is a 400', () => {
    const q = listInputSchema(PlaceSpec).parse({ sort: 'location' });
    expect(() => buildListSql(places, PlaceSpec.list, q)).toThrow(BadRequestException);
  });
});

describe('points and addresses', () => {
  it('reads PostGIS hex EWKB, with or without an SRID, in either byte order', () => {
    // SELECT 'SRID=4326;POINT(77.59 12.97)'::geography
    expect(readEwkbPoint('0101000020E6100000F6285C8FC2655340713D0AD7A3F02940')).toEqual({
      lng: 77.59,
      lat: 12.97,
    });
    // Big-endian, no SRID: POINT(1 2)
    expect(readEwkbPoint('00000000013FF00000000000004000000000000000')).toEqual({ lng: 1, lat: 2 });
    // A line is not a point.
    expect(() =>
      readEwkbPoint('0102000000020000000000000000000000000000000000000000000000000000000000F03F'),
    ).toThrow('Not a point');
  });

  it('measures on a sphere for display, close to the spheroid', () => {
    expect(distanceMeters(HERE, HERE)).toBe(0);
    const north = distanceMeters(HERE, { lat: 12.9743, lng: 77.5946 });
    expect(north).toBeGreaterThan(296);
    expect(north).toBeLessThan(304);
  });

  it('writes an address on one line', () => {
    const a = Address.parse({
      line1: ' 1 First Street ',
      locality: 'Springfield',
      postalCode: '500001',
      country: 'IN',
    });
    expect(addressText(a)).toBe('1 First Street, Springfield 500001, IN');
    expect(Address.safeParse({ line1: 'x', country: 'india' }).success).toBe(false);
  });
});
