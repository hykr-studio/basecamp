// Places on the map (B13): points read and written as { lat, lng }, the `near` and `within`
// list filters, the distance sort with keyset cursors, and a geofence check in a command, on
// the fixture's spots (fixture/src/features/geo). A read projector hides a spot's place from
// staff.
import { toQueryString } from '@hykr/contracts';
import { CORE_OPTIONS, type CoreOptions, metersBetween, withinMeters } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { geoApp } from '../fixture/dist/features/geo/index.js';

const owner = new Person('Owner Geo');
const staff = new Person('Staff Geo');
const other = new Person('Other Geo');
let tenantId = '';

/** A point and the ones around it: about 300 m north, 2 km east, and another city. */
const HERE = { lat: 12.9716, lng: 77.5946 };
const NORTH_300 = { lat: 12.9743, lng: 77.5946 };
const EAST_2K = { lat: 12.9716, lng: 77.6131 };
const FAR = { lat: 17.385, lng: 78.4867 };
const STEP_55 = { lat: 12.9721, lng: 77.5946 };

const ids: Record<string, string> = {};

const db = () => {
  if (!server.app) throw new Error('The app is not booted');
  return (server.app.get(CORE_OPTIONS, { strict: false }) as CoreOptions).db;
};
const inOwner = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });
const titles = (body: { items: { title: string }[] }) => body.items.map((s) => s.title);

const audits = async (action: string, outcome: string) =>
  (
    await pool.query(
      'select rule, resource_id from audit.events where tenant_id = $1 and action = $2 and outcome = $3',
      [tenantId, action, outcome],
    )
  ).rows as { rule: string; resource_id: string }[];

beforeAll(async () => {
  await boot(geoApp);
  for (const p of [owner, staff, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  const spots: [string, object | null][] = [
    ['Here', HERE],
    ['North', NORTH_300],
    ['East', EAST_2K],
    ['Far', FAR],
    ['Nowhere', null],
  ];
  for (const [title, location] of spots) {
    const res = await owner.call('POST', '/api/spots', {
      title,
      location,
      ...(title === 'Here'
        ? { address: { line1: '1 First Street', locality: 'Springfield', country: 'IN' } }
        : {}),
    });
    expect(res.status).toBe(201);
    ids[title] = res.body.value.id;
  }
  // Another business's spot, at the same place.
  expect((await other.call('POST', '/api/spots', { title: 'Theirs', location: HERE })).status).toBe(
    201,
  );
});
afterAll(shutdown);

describe('a point', () => {
  it('is written and read as { lat, lng }, exactly, with its address', async () => {
    const res = await owner.call('GET', `/api/spots/${ids.Here}`);
    expect(res.body).toMatchObject({
      title: 'Here',
      location: HERE,
      address: { line1: '1 First Street', locality: 'Springfield', country: 'IN' },
    });
    expect((await owner.call('GET', `/api/spots/${ids.Nowhere}`)).body.location).toBeNull();
  });

  it('is stored as PostGIS geography (SRID 4326)', async () => {
    const { rows } = await pool.query(
      'select ST_AsText(location) as wkt, ST_SRID(location) as srid from app.fixture_spots where id = $1',
      [ids.North],
    );
    expect(rows[0]).toEqual({ wkt: 'POINT(77.5946 12.9743)', srid: 4326 });
  });

  it('can be moved and cleared', async () => {
    const created = await owner.call('POST', '/api/spots', { title: 'Moving', location: HERE });
    const id = created.body.value.id;
    const moved = await owner.call('PATCH', `/api/spots/${id}`, { location: FAR });
    expect(moved.body.value.location).toEqual(FAR);
    const cleared = await owner.call('PATCH', `/api/spots/${id}`, { location: null });
    expect(cleared.body.value.location).toBeNull();
    const gone = await owner.call('DELETE', `/api/spots/${id}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  });

  it('out of range is refused', async () => {
    const res = await owner.call('POST', '/api/spots', {
      title: 'Bad',
      location: { lat: 91, lng: 0 },
    });
    expect(res.status).toBe(400);
  });
});

describe('the near and within filters', () => {
  it('near: within a radius, from the query string', async () => {
    const res = await owner.call('GET', `/api/spots?location[near]=${HERE.lat},${HERE.lng},500`);
    expect(res.status).toBe(200);
    expect(titles(res.body).sort()).toEqual(['Here', 'North']);
    const wide = await owner.call('GET', `/api/spots?location[near]=${HERE.lat},${HERE.lng},5000`);
    expect(titles(wide.body).sort()).toEqual(['East', 'Here', 'North']);
  });

  it('near: the JSON form a client sends (toQueryString)', async () => {
    const qs = toQueryString({ location: { near: { ...HERE, radiusM: 500 } } });
    expect(qs).toContain('location%5Bnear%5D=');
    const res = await owner.call('GET', `/api/spots${qs}`);
    expect(titles(res.body).sort()).toEqual(['Here', 'North']);
  });

  it('within: a box, south-west to north-east', async () => {
    const res = await owner.call('GET', '/api/spots?location[within]=12.96,77.58,12.98,77.60');
    expect(titles(res.body).sort()).toEqual(['Here', 'North']);
  });

  it('with another filter and the count', async () => {
    const res = await owner.call(
      'GET',
      `/api/spots?location[near]=${HERE.lat},${HERE.lng},5000&title[contains]=or&count=true`,
    );
    expect(titles(res.body)).toEqual(['North']);
    expect(res.body.total).toBe(1);
  });

  it('bad values are a 400', async () => {
    for (const q of [
      `location[near]=${HERE.lat},${HERE.lng},0`,
      `location[near]=${HERE.lat},${HERE.lng}`,
      'location[near]=a,b,c',
      'location[within]=12.98,77.58,12.96,77.60',
      'location[within]=12.96,179,12.98,-179',
      `location=${HERE.lat},${HERE.lng}`,
      'location[eq]=1,2',
    ])
      expect((await owner.call('GET', `/api/spots?${q}`)).status, q).toBe(400);
  });
});

describe('the distance sort', () => {
  const near = `location[near]=${HERE.lat},${HERE.lng},1000000`;

  it('nearest first, or farthest first', async () => {
    const asc = await owner.call('GET', `/api/spots?${near}&sort=location`);
    expect(titles(asc.body)).toEqual(['Here', 'North', 'East', 'Far']);
    const desc = await owner.call('GET', `/api/spots?${near}&sort=-location`);
    expect(titles(desc.body)).toEqual(['Far', 'East', 'North', 'Here']);
  });

  it('pages with cursors never skip or repeat', async () => {
    for (const sort of ['location', '-location']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { items: { title: string }[]; nextCursor: string | null } } =
          await owner.call(
            'GET',
            `/api/spots?${near}&sort=${sort}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
        seen.push(...titles(page.body));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(
        sort === 'location' ? ['Here', 'North', 'East', 'Far'] : ['Far', 'East', 'North', 'Here'],
      );
    }
  });

  it('two spots at the same distance keep a total order', async () => {
    const twin = await owner.call('POST', '/api/spots', { title: 'Twin', location: NORTH_300 });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: { title: string }[]; nextCursor: string | null } } =
        await owner.call(
          'GET',
          `/api/spots?${near}&sort=location&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
      seen.push(...titles(page.body));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    await owner.call('DELETE', `/api/spots/${twin.body.value.id}`);
  });

  it('without a near point it is a 400', async () => {
    const res = await owner.call('GET', '/api/spots?sort=location');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sort_needs_near');
  });
});

describe('another business', () => {
  it('never sees these spots, near or by id', async () => {
    const near = await other.call('GET', `/api/spots?location[near]=${HERE.lat},${HERE.lng},500`);
    expect(titles(near.body)).toEqual(['Theirs']);
    expect((await other.call('GET', `/api/spots/${ids.Here}`)).status).toBe(404);
    const arrive = await other.call('POST', `/api/spots/${ids.Here}/arrive`, { at: HERE });
    expect(arrive.status).toBe(404);
  });
});

describe('a hidden place', () => {
  it('staff see the spot, not its point or address', async () => {
    const res = await inOwner(staff)('GET', `/api/spots/${ids.Here}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Here');
    expect(res.body).not.toHaveProperty('location');
    expect(res.body).not.toHaveProperty('address');
  });

  it('a list near a point shows staff the spots, still without their place', async () => {
    const res = await inOwner(staff)(
      'GET',
      `/api/spots?location[near]=${HERE.lat},${HERE.lng},500&sort=location`,
    );
    expect(titles(res.body)).toEqual(['Here', 'North']);
    for (const spot of res.body.items) expect(spot).not.toHaveProperty('location');
  });
});

describe('checking in within a geofence', () => {
  it('within the radius: taken, with the distance PostGIS measured', async () => {
    const res = await owner.call('POST', `/api/spots/${ids.Here}/arrive`, {
      at: STEP_55,
      accuracyM: 20,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.value).toMatchObject({ spotId: ids.Here, location: STEP_55, accuracyM: 20 });
    expect(res.body.value.distanceM).toBeGreaterThan(50);
    expect(res.body.value.distanceM).toBeLessThan(60);
    expect((await audits('spot.arrive', 'committed')).map((r) => r.rule)).toContain(
      'within_geofence',
    );
  });

  it('outside the radius: refused with how far, and audited', async () => {
    const res = await owner.call('POST', `/api/spots/${ids.Here}/arrive`, { at: NORTH_300 });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('outside_geofence');
    expect(res.body.reason).toMatch(/You are 29\d m from Here/);
    expect((await audits('spot.arrive', 'denied')).map((r) => r.rule)).toContain(
      'outside_geofence',
    );
  });

  it('a fix less precise than the radius is refused', async () => {
    const res = await owner.call('POST', `/api/spots/${ids.Here}/arrive`, {
      at: HERE,
      accuracyM: 150,
    });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('imprecise_location');
  });

  it('a spot with no place takes no check-in', async () => {
    const res = await owner.call('POST', `/api/spots/${ids.Nowhere}/arrive`, { at: HERE });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('no_place');
  });

  it('staff check in at a spot whose place they cannot see', async () => {
    const res = await inOwner(staff)('POST', `/api/spots/${ids.Here}/arrive`, { at: HERE });
    expect(res.status).toBe(200);
    expect(res.body.value.distanceM).toBe(0);
  });

  it('arrivals are taken only through the command', async () => {
    const res = await owner.call('POST', '/api/spotArrivals', {
      spotId: ids.Here,
      location: HERE,
      distanceM: 0,
    });
    expect(res.status).toBe(404);
  });

  it("the assistant's check-in waits for the person, audited as parked", async () => {
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const before = (await owner.call('GET', `/api/spotArrivals?spotId=${ids.Here}`)).body.items
      .length;
    const parked = await asks('POST', `/api/spots/${ids.Here}/arrive`, { at: HERE });
    expect(parked.body.status).toBe('needs_approval');
    const approvalId = parked.body.approval.id;
    expect((await audits('spot.arrive', 'needs_approval')).map((r) => r.rule)).toContain(
      'agent_arrives',
    );
    const waiting = await owner.call('GET', `/api/spotArrivals?spotId=${ids.Here}`);
    expect(waiting.body.items).toHaveLength(before);
    const approved = await owner.call('POST', `/api/approvals/${approvalId}/approve`);
    expect(approved.body.status).toBe('approved');
    const after = await owner.call('GET', `/api/spotArrivals?spotId=${ids.Here}`);
    expect(after.body.items).toHaveLength(before + 1);
  });

  it('arrivals near a point', async () => {
    const res = await owner.call(
      'GET',
      `/api/spotArrivals?spotId=${ids.Here}&location[near]=${STEP_55.lat},${STEP_55.lng},5`,
    );
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].location).toEqual(STEP_55);
  });
});

describe('withinMeters and metersBetween', () => {
  it('measure on the spheroid, the same as the near filter', async () => {
    const m = await metersBetween(db(), HERE, NORTH_300);
    expect(m).toBeGreaterThan(295);
    expect(m).toBeLessThan(302);
    expect(await withinMeters(db(), HERE, NORTH_300, 300)).toEqual({ inside: true, distanceM: m });
    expect((await withinMeters(db(), HERE, NORTH_300, 290)).inside).toBe(false);
  });
});
