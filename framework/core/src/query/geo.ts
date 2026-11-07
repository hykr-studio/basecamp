import type { Bounds, GeoPoint, Near } from '@hykr/contracts';
import { pointSql } from '@hykr/db';
import { BadRequestException } from '@nestjs/common';
import { type Column, type SQL, sql } from 'drizzle-orm';
import type { Conn } from '../tokens.js';
import { type ListFieldFilter, type ListFieldSort, listFieldSql } from './field-sql.js';

/**
 * The SQL of the `geo` list field type (its grammar is in @hykr/contracts): PostGIS on a
 * `geography` point column (`geoPoint`). Distances are metres on the WGS84 spheroid, the same
 * for the `near` filter, the distance sort and `withinMeters`.
 */

/** Past any distance on the earth: where rows without a point sort. */
const FAR_M = 1e9;

const columnOf = (column: Column | undefined, field: string): Column => {
  if (!column) throw new Error(`List config names "${field}", which is not a column`);
  return column;
};

function geoWhere({ column, field, op, value }: ListFieldFilter): SQL {
  const col = columnOf(column, field);
  if (op === 'near') {
    const near = value as Near;
    return sql`ST_DWithin(${col}, ${pointSql(near)}, ${near.radiusM}::float8)`;
  }
  if (op === 'within') {
    const b = value as Bounds;
    const box = sql`ST_MakeEnvelope(${b.west}::float8, ${b.south}::float8, ${b.east}::float8, ${b.north}::float8, 4326)::geography`;
    return sql`ST_Intersects(${col}, ${box})`;
  }
  throw new Error(`The operator "${op}" does not apply to field "${field}"`);
}

/** Sorted by distance to the point of the list's `near` filter on the same field. */
function geoOrder({ column, field, filters }: ListFieldSort) {
  const col = columnOf(column, field);
  const near = filters.find((f) => f.op === 'near')?.value as Near | undefined;
  if (!near)
    throw new BadRequestException({
      error: 'sort_needs_near',
      message: `Sorting by ${field} is by distance: add a ${field}[near] filter to measure from`,
    });
  const from = pointSql(near);
  return {
    expr: sql`coalesce(ST_Distance(${col}, ${from}), ${FAR_M}::float8)`,
    at: (value: unknown) =>
      value && typeof value === 'object'
        ? sql`ST_Distance(${pointSql(value as GeoPoint)}, ${from})`
        : sql`${FAR_M}::float8`,
  };
}

listFieldSql.register({ name: 'geo', where: geoWhere, order: geoOrder });

/** Metres between two points, measured by PostGIS (the WGS84 spheroid). */
export async function metersBetween(conn: Conn, a: GeoPoint, b: GeoPoint): Promise<number> {
  const result = await conn.execute(sql`select ST_Distance(${pointSql(a)}, ${pointSql(b)}) as m`);
  return Number((result.rows[0] as { m: number | string }).m);
}

/**
 * A geofence check: is `at` within `radiusM` metres of `center`? Measured like the `near`
 * filter. Run it in a command's `load` (it needs the transaction) and decide in `authorize`:
 *
 *   load: async (tx, p, input) => {
 *     const place = await Place.repo.get(tx, p, input.placeId);
 *     return { place, fence: place.location && (await withinMeters(tx, input.at, place.location, 200)) };
 *   },
 */
export async function withinMeters(
  conn: Conn,
  at: GeoPoint,
  center: GeoPoint,
  radiusM: number,
): Promise<{ inside: boolean; distanceM: number }> {
  const distanceM = await metersBetween(conn, at, center);
  return { inside: distanceM <= radiusM, distanceM };
}
