import { z } from 'zod';
import { defineListFieldType } from './list.js';

/**
 * Places on the map (B13): a point in WGS84 degrees, a postal address, and the `geo` list field
 * type, whose SQL (PostGIS) is in @hykr/core. A record keeps its point in a `geoPoint()` column
 * (@hykr/db) and its address beside it in an `addressColumn()`.
 */

/** A point on the earth: latitude and longitude in degrees (WGS84, as a phone's GPS gives). */
export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/** The longest distance on the earth's surface, a little over half its circumference. */
export const MAX_RADIUS_M = 20_040_000;

/** Within a radius of a point: `near: { lat, lng, radiusM }`, the radius in metres. */
export const Near = GeoPoint.extend({ radiusM: z.number().positive().max(MAX_RADIUS_M) });
export type Near = z.infer<typeof Near>;

/**
 * A box on the map, as a map's visible area: its south-west and north-east corners. A box
 * across the antimeridian (west east of east) is refused: send two.
 */
export const Bounds = z
  .object({
    south: z.number().min(-90).max(90),
    west: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
  })
  .refine((b) => b.south <= b.north, { message: 'south must not be north of north' })
  .refine((b) => b.west <= b.east, {
    message: 'west must not be east of east (split a box across the antimeridian in two)',
  });
export type Bounds = z.infer<typeof Bounds>;

/**
 * A postal address, as people write it. Its coordinates are kept beside it, in the record's
 * point column, so they can be indexed and filtered.
 */
export const Address = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  locality: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  /** ISO 3166-1 alpha-2, upper case: "IN", "DE". */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, 'Use the two-letter ISO 3166 country code')
    .optional(),
});
export type Address = z.infer<typeof Address>;

/** An address on one line: "12 Main Road, Floor 2, Springfield 500001". */
export function addressText(a: Address): string {
  const place = [a.locality, a.postalCode].filter(Boolean).join(' ');
  return [a.line1, a.line2, place, a.region, a.country].filter(Boolean).join(', ');
}

/** The earth's mean radius (IUGG), in metres. */
const EARTH_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Metres between two points on a sphere (haversine): close to PostGIS's spheroid distance
 * (within about half a percent). For showing a distance only: the server decides with
 * `withinMeters` (@hykr/core), which measures as the `near` filter does.
 */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

declare module './list.js' {
  interface ListFieldTypes {
    geo: true;
  }
  interface ListFilterOps {
    near: true;
    within: true;
  }
}

/** Numbers from "12.97,77.59,500", or a JSON object as `toQueryString` sends it. */
function fromText(names: readonly string[]) {
  return (v: unknown) => {
    if (typeof v !== 'string') return v;
    const text = v.trim();
    if (text.startsWith('{')) {
      try {
        return JSON.parse(text);
      } catch {
        return v;
      }
    }
    const parts = text.split(',').map((x) => x.trim());
    if (parts.length !== names.length || parts.some((x) => x === '' || Number.isNaN(Number(x))))
      return v;
    return Object.fromEntries(names.map((name, i) => [name, Number(parts[i])]));
  };
}

/**
 * A point field in a list filter:
 *   location[near]=12.97,77.59,500          within 500 m      { near: { lat, lng, radiusM } }
 *   location[within]=12.9,77.5,13.1,77.7     in a box (s,w,n,e) { within: { south, west, north, east } }
 * A geo field in `sortable` sorts by distance to the point of its `near` filter.
 */
defineListFieldType({
  name: 'geo',
  ops: ['near', 'within'],
  value: () => z.preprocess(fromText(['lat', 'lng']), GeoPoint),
  opValue: (op) =>
    op === 'near'
      ? z.preprocess(fromText(['lat', 'lng', 'radiusM']), Near.strict())
      : op === 'within'
        ? z.preprocess(fromText(['south', 'west', 'north', 'east']), Bounds)
        : undefined,
});
