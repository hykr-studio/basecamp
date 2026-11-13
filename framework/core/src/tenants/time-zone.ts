// A business's time zone, resolved in one place: its own `timeZone` setting when it is a zone
// this process can use, else the deployment's (DEFAULT_TIME_ZONE), else UTC. Every business
// period (number series, credit periods, summary buckets, business hours, quiet hours, document
// dates, agent schedules) reads it here, so no two parts of the framework disagree. Some are
// computed in JS (Intl) and some in SQL (Postgres's AT TIME ZONE), so a usable zone is one both
// read the same way. docs/decisions/X2.md.
import { isTimeZone, zoneOffsetMinutes } from '@hykr/contracts';
import { schema } from '@hykr/db';
import { eq, sql } from 'drizzle-orm';
import type { Conn } from '../tokens.js';

/** The zone of a business that set none, in a deployment that set none. */
export const NEUTRAL_TIME_ZONE = 'UTC';

let deployment: string | undefined;

/** The zone names this deployment's Postgres knows, in lower case, once read at start. */
let postgresZones: ReadonlySet<string> | undefined;

/**
 * A zone this process can use in JS and in SQL alike: `isTimeZone` (UTC or an Area/Location
 * name Intl knows, never an offset or an abbreviation), and a name Postgres knows once this
 * process has read them (`checkTimeZones`, at start).
 */
const usable = (value: unknown): value is string =>
  isTimeZone(value) && (postgresZones === undefined || postgresZones.has(value.toLowerCase()));

/** Why a deployment zone is refused: the same words at start and in `setDefaultTimeZone`. */
const refused = (zone: string) =>
  `DEFAULT_TIME_ZONE must be UTC or an IANA zone name such as Europe/Berlin that Postgres reads the same way (not an offset or an abbreviation), not "${zone}"`;

/**
 * The deployment's zone for businesses that set none (DEFAULT_TIME_ZONE), set once when the
 * server starts. Empty or undefined: UTC. A name this process cannot use throws.
 */
export function setDefaultTimeZone(zone: string | undefined): void {
  const given = zone?.trim();
  if (!given) {
    deployment = undefined;
    return;
  }
  if (!usable(given)) throw new Error(refused(zone ?? ''));
  deployment = given;
}

/** Six months on: a second instant, so a zone's summer and winter offsets are both compared. */
const HALF_YEAR_MS = 182 * 86_400_000;

/**
 * Postgres's name for this zone when JS and SQL read it the same way, else null: `isTimeZone`,
 * a name in `pg_timezone_names` (matched without regard to case; Postgres's spelling is
 * returned), and the same offset from UTC in Intl and in Postgres now and six months on (their
 * time zone databases are not the same files and may be of different releases).
 */
export async function zoneName(conn: Conn, value: unknown): Promise<string | null> {
  if (!isTimeZone(value)) return null;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const at = [now, now + HALF_YEAR_MS] as const;
  const [first, second] = at.map((t) => new Date(t).toISOString());
  const offset = (instant: string) =>
    sql`round(extract(epoch from (${instant}::timestamptz at time zone name) - (${instant}::timestamptz at time zone 'UTC')) / 60)`;
  const { rows } = await conn.execute<{ name: string; first: unknown; second: unknown }>(sql`
    select name, ${offset(first)} as first, ${offset(second)} as second
    from pg_timezone_names where lower(name) = lower(${value})
    order by name = ${value} desc limit 1`);
  const row = rows[0];
  if (!row) return null;
  const same =
    Number(row.first) === zoneOffsetMinutes(at[0], value) &&
    Number(row.second) === zoneOffsetMinutes(at[1], value);
  return same ? row.name : null;
}

/**
 * At start: read the zone names Postgres knows (a stored zone it does not know is then ignored,
 * like one Intl does not know), and check the deployment's zone with `zoneName`, keeping
 * Postgres's spelling. A deployment zone the two do not read the same way stops the start.
 */
export async function checkTimeZones(conn: Conn): Promise<void> {
  const { rows } = await conn.execute<{ name: string }>(sql`select name from pg_timezone_names`);
  postgresZones = new Set(rows.map((r) => r.name.toLowerCase()));
  if (deployment === undefined) return;
  const name = await zoneName(conn, deployment);
  if (!name) throw new Error(refused(deployment));
  deployment = name;
}

/** The zone of a business that set none: the deployment's, else UTC. */
export const defaultTimeZone = (): string => deployment ?? NEUTRAL_TIME_ZONE;

/**
 * A business's time zone from its settings (the stored jsonb or the parsed `TenantConfig`): its
 * own `timeZone` when it is a zone this process can use, else the deployment's, else UTC. A bad
 * stored value (an offset, an abbreviation, a name Intl or Postgres does not know) never throws.
 */
export function tenantZone(settings: unknown): string {
  const own =
    settings !== null && typeof settings === 'object'
      ? (settings as { timeZone?: unknown }).timeZone
      : undefined;
  return usable(own) ? own : defaultTimeZone();
}

/**
 * A business's time zone, read now (in the caller's transaction, if given). Only the
 * `timeZone` key is read, so another setting's bad value does not change it. An unknown
 * business has the deployment's.
 */
export async function tenantZoneOf(conn: Conn, tenantId: string): Promise<string> {
  const [row] = await conn
    .select({ timeZone: sql<unknown>`${schema.tenants.settings} -> 'timeZone'` })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  return tenantZone(row);
}
