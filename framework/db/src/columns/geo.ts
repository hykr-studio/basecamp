import { type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, customType, index, jsonb } from 'drizzle-orm/pg-core';

/**
 * Places on the map (B13): a point column (PostGIS `geography`, enabled by
 * `sql/pre/10-postgis.sql`), its GiST index, and an address column. Give the point column the
 * spec field's key, and list the field as `'geo'` in `filterable` (near, within) and, to sort by
 * distance to a `near` point, in `sortable`.
 *
 *   location: geoPoint('location'),
 *   address: addressColumn('address'),
 *   …
 *   (t) => [geoIndex('meetings_location_gist', t.location)]
 */

/** A point in WGS84 degrees: `GeoPoint` in @hykr/contracts. */
export type GeoPointValue = { lat: number; lng: number };

/** A postal address: `Address` in @hykr/contracts. */
export type AddressValue = {
  line1: string;
  line2?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

const EWKB_SRID = 0x20000000;

/**
 * A point from PostGIS's hex EWKB, as node-postgres returns a geography: byte order, type (with
 * the SRID flag), SRID, then x (longitude) and y (latitude) as doubles.
 */
export function readEwkbPoint(hex: string): GeoPointValue {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  const little = view.getUint8(0) === 1;
  const type = view.getUint32(1, little);
  if ((type & 0xff) !== 1) throw new Error(`Not a point: geometry type ${type & 0xff}`);
  const at = type & EWKB_SRID ? 9 : 5;
  return { lng: view.getFloat64(at, little), lat: view.getFloat64(at + 8, little) };
}

/** A point as PostGIS geography. Longitude first, as PostGIS orders x and y. */
export const pointSql = (p: GeoPointValue): SQL =>
  sql`ST_SetSRID(ST_MakePoint(${p.lng}::float8, ${p.lat}::float8), 4326)::geography`;

/**
 * A point column, read and written as `{ lat, lng }`. Its type is plain `geography` (WGS84):
 * drizzle-kit writes a type with a modifier as one quoted name (`"geography(Point,4326)"`,
 * which Postgres refuses), so the table does not narrow the column to points. Every write goes
 * through `pointSql` (a point, SRID 4326) and a read refuses anything but a point.
 */
export const geoPoint = customType<{ data: GeoPointValue; driverData: string }>({
  dataType: () => 'geography',
  toDriver: (value) => pointSql(value),
  fromDriver: (value) => readEwkbPoint(value),
});

/** The GiST index the `near` and `within` filters use. */
export const geoIndex = (name: string, column: AnyPgColumn) => index(name).using('gist', column);

/** A postal address (jsonb); keep its coordinates in a `geoPoint` column beside it. */
export const addressColumn = (name: string) => jsonb(name).$type<AddressValue>();
