import { isTimeZone } from '@hykr/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { Conn } from '../tokens.js';
import {
  checkTimeZones,
  defaultTimeZone,
  setDefaultTimeZone,
  tenantZone,
  zoneName,
} from './time-zone.js';

/** A connection that answers each query with the next rows given, and counts the queries. */
function answering(...answers: Record<string, unknown>[][]) {
  const conn = {
    queries: 0,
    execute: async () => {
      conn.queries += 1;
      return { rows: answers.shift() ?? [] };
    },
  };
  return conn as typeof conn & Conn;
}

afterEach(() => setDefaultTimeZone(undefined));

describe('isTimeZone', () => {
  it('knows IANA zones and UTC', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
  });

  it('knows Area/Location names in any case, the legacy ones and the Etc ones', () => {
    expect(isTimeZone('asia/tokyo')).toBe(true);
    expect(isTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isTimeZone('America/Port-au-Prince')).toBe(true);
    expect(isTimeZone('US/Eastern')).toBe(true);
    expect(isTimeZone('Etc/GMT+5')).toBe(true);
    expect(isTimeZone('Etc/UTC')).toBe(true);
  });

  it('refuses offsets and abbreviations, which Intl takes and Postgres reads otherwise', () => {
    // Postgres: "+0530" is not recognized, "+05:30" is UTC-05:30, "IST" is Israel's.
    for (const zone of ['IST', '+05:30', '+0530', '-03', 'EST', 'CET', 'GMT', 'EST5EDT', 'utc'])
      expect(isTimeZone(zone), zone).toBe(false);
  });

  it('refuses what is not a zone', () => {
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone('x'.repeat(65))).toBe(false);
    expect(isTimeZone(undefined)).toBe(false);
    expect(isTimeZone(null)).toBe(false);
    expect(isTimeZone(330)).toBe(false);
    expect(isTimeZone({ timeZone: 'UTC' })).toBe(false);
  });
});

describe('the deployment default', () => {
  it('is UTC when the deployment sets none', () => {
    setDefaultTimeZone(undefined);
    expect(defaultTimeZone()).toBe('UTC');
    setDefaultTimeZone('');
    expect(defaultTimeZone()).toBe('UTC');
    setDefaultTimeZone('   ');
    expect(defaultTimeZone()).toBe('UTC');
  });

  it('is the zone the deployment sets', () => {
    setDefaultTimeZone(' Europe/Lisbon ');
    expect(defaultTimeZone()).toBe('Europe/Lisbon');
  });

  it('refuses a name that is not a zone, and keeps the one it had', () => {
    setDefaultTimeZone('Asia/Tokyo');
    for (const zone of ['Mars/Olympus', 'IST', '+05:30', '+0530'])
      expect(() => setDefaultTimeZone(zone), zone).toThrow(
        'DEFAULT_TIME_ZONE must be UTC or an IANA zone name',
      );
    expect(defaultTimeZone()).toBe('Asia/Tokyo');
  });
});

describe('tenantZone', () => {
  it("is the business's own zone", () => {
    setDefaultTimeZone('Asia/Tokyo');
    expect(tenantZone({ timeZone: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it("is the deployment's when the business set none, or one that is not a zone", () => {
    setDefaultTimeZone('Asia/Tokyo');
    expect(tenantZone({})).toBe('Asia/Tokyo');
    expect(tenantZone(undefined)).toBe('Asia/Tokyo');
    expect(tenantZone(null)).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: 'Mars/Olympus' })).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: 42 })).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: null })).toBe('Asia/Tokyo');
    // Offsets and abbreviations too: JS and SQL would read them as different zones.
    expect(tenantZone({ timeZone: 'IST' })).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: '+05:30' })).toBe('Asia/Tokyo');
    expect(tenantZone({ timeZone: '+0530' })).toBe('Asia/Tokyo');
  });

  it('is UTC when neither the business nor the deployment set one', () => {
    expect(tenantZone({})).toBe('UTC');
    expect(tenantZone({ timeZone: 'nowhere' })).toBe('UTC');
  });
});

describe('zoneName: the zone as Postgres names it, when it reads it as Intl does', () => {
  // Tokyo keeps one offset all year (540 minutes), whatever today's date.
  it("is Postgres's spelling of a zone both know, with the same offsets", async () => {
    const tokyo = { name: 'Asia/Tokyo', first: '540', second: '540' };
    expect(await zoneName(answering([tokyo]), 'Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(await zoneName(answering([tokyo]), 'asia/tokyo')).toBe('Asia/Tokyo');
  });

  it('is null for a zone Postgres does not know, or reads with another offset', async () => {
    expect(await zoneName(answering([]), 'Asia/Tokyo')).toBeNull();
    const drifted = { name: 'Asia/Tokyo', first: '540', second: '600' };
    expect(await zoneName(answering([drifted]), 'Asia/Tokyo')).toBeNull();
  });

  it('is null for an offset or an abbreviation, without asking Postgres', async () => {
    for (const zone of ['IST', '+05:30', '+0530', 'Mars/Olympus', 42]) {
      const conn = answering([{ name: 'IST', first: '330', second: '330' }]);
      expect(await zoneName(conn, zone)).toBeNull();
      expect(conn.queries).toBe(0);
    }
  });
});

// Last: once Postgres's zones are read, they stay read for the rest of this file.
describe('at start (checkTimeZones)', () => {
  const names = (...zones: string[]) => zones.map((name) => ({ name }));

  it("keeps Postgres's spelling of the deployment's zone", async () => {
    setDefaultTimeZone('asia/tokyo');
    await checkTimeZones(
      answering(names('UTC', 'Asia/Tokyo'), [{ name: 'Asia/Tokyo', first: 540, second: 540 }]),
    );
    expect(defaultTimeZone()).toBe('Asia/Tokyo');
  });

  it("stops the start when Postgres does not read the deployment's zone as Intl does", async () => {
    setDefaultTimeZone('Asia/Tokyo');
    await expect(checkTimeZones(answering(names('UTC', 'Asia/Tokyo'), []))).rejects.toThrow(
      'DEFAULT_TIME_ZONE must be UTC or an IANA zone name',
    );
  });

  it('then ignores a zone Postgres does not know, stored or deployed', async () => {
    await checkTimeZones(answering(names('UTC', 'Asia/Tokyo', 'Europe/Berlin')));
    setDefaultTimeZone('Asia/Tokyo');
    expect(tenantZone({ timeZone: 'europe/berlin' })).toBe('europe/berlin');
    // Intl knows Lisbon; this Postgres does not.
    expect(tenantZone({ timeZone: 'Europe/Lisbon' })).toBe('Asia/Tokyo');
    expect(() => setDefaultTimeZone('Europe/Lisbon')).toThrow('DEFAULT_TIME_ZONE');
  });
});
