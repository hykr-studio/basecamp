// A business's time zone, resolved in one place: its own `timeZone` setting when it is a zone
// this process knows, else the deployment's (DEFAULT_TIME_ZONE), else UTC. Every business
// period (number series, credit periods, summary buckets, business hours, quiet hours, document
// dates, agent schedules) reads it here, so no two parts of the framework disagree.
// docs/decisions/X2.md.
import { isTimeZone } from '@hykr/contracts';
import { schema } from '@hykr/db';
import { eq, sql } from 'drizzle-orm';
import type { Conn } from '../tokens.js';

/** The zone of a business that set none, in a deployment that set none. */
export const NEUTRAL_TIME_ZONE = 'UTC';

let deployment: string | undefined;

/**
 * The deployment's zone for businesses that set none (DEFAULT_TIME_ZONE), set once when the
 * server starts. Empty or undefined: UTC. A name this process does not know throws.
 */
export function setDefaultTimeZone(zone: string | undefined): void {
  const given = zone?.trim();
  if (!given) {
    deployment = undefined;
    return;
  }
  if (!isTimeZone(given))
    throw new Error(
      `DEFAULT_TIME_ZONE must be an IANA time zone such as Europe/Berlin, not "${zone}"`,
    );
  deployment = given;
}

/** The zone of a business that set none: the deployment's, else UTC. */
export const defaultTimeZone = (): string => deployment ?? NEUTRAL_TIME_ZONE;

/**
 * A business's time zone from its settings (the stored jsonb or the parsed `TenantConfig`): its
 * own `timeZone` when it is a zone this process knows, else the deployment's, else UTC. A bad
 * stored value never throws.
 */
export function tenantZone(settings: unknown): string {
  const own =
    settings !== null && typeof settings === 'object'
      ? (settings as { timeZone?: unknown }).timeZone
      : undefined;
  return isTimeZone(own) ? own : defaultTimeZone();
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
