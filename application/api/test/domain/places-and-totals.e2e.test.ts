// The sample's places and totals (B13, B14): meetings with an address and a point, listed near
// a point nearest first, and checked in at only within the module's radius; orders counted and
// totalled by status and by month, on the API, as live kpi.row tiles, and by the assistant.

import { addMember, asAssistant, boot, me, Person, pool, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Places');
const staff = new Person('Staff Places');
const stranger = new Person('Stranger Places');
let tenantId = '';
const inTenant = { 'x-tenant-id': '' };

const OFFICE = { lat: 17.4474, lng: 78.3762 };
const NEARBY = { lat: 17.4483, lng: 78.3762 }; // about 100 m north
const ACROSS_TOWN = { lat: 17.4474, lng: 78.4074 }; // about 3.3 km east

const day = (offset: number, time: string) =>
  `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T${time}:00.000Z`;

async function meeting(who: Person, title: string, place: object) {
  const res = await who.call('POST', '/api/meetings', {
    title,
    startsAt: day(1, '10:00'),
    endsAt: day(1, '11:00'),
    ...place,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.value as { id: string };
}

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  inTenant['x-tenant-id'] = tenantId;
  await addMember(staff, tenantId, ['staff']);
});
afterAll(shutdown);

describe('meetings on the map', () => {
  const ids: Record<string, string> = {};

  it('keeps an address and a point', async () => {
    ids.office = (
      await meeting(owner, 'Office review', {
        address: { line1: '1 Cyber Towers', locality: 'Hyderabad', country: 'IN' },
        location: OFFICE,
      })
    ).id;
    ids.across = (await meeting(owner, 'Across town', { location: ACROSS_TOWN })).id;
    ids.nowhere = (await meeting(owner, 'No place', {})).id;
    const got = await owner.call('GET', `/api/meetings/${ids.office}`);
    expect(got.body).toMatchObject({
      address: { line1: '1 Cyber Towers', locality: 'Hyderabad', country: 'IN' },
      location: OFFICE,
    });
    expect((await owner.call('GET', `/api/meetings/${ids.nowhere}`)).body.location).toBeNull();
  });

  it('lists meetings near a point, nearest first', async () => {
    const near = await owner.call(
      'GET',
      `/api/meetings?location[near]=${NEARBY.lat},${NEARBY.lng},5000&sort=location`,
    );
    expect(near.status).toBe(200);
    expect(near.body.items.map((m: { title: string }) => m.title)).toEqual([
      'Office review',
      'Across town',
    ]);
    const close = await owner.call(
      'GET',
      `/api/meetings?location[near]=${NEARBY.lat},${NEARBY.lng},500`,
    );
    expect(close.body.items.map((m: { title: string }) => m.title)).toEqual(['Office review']);
    // Another business's meetings are never near anyone here.
    const theirs = await stranger.call(
      'GET',
      `/api/meetings?location[near]=${OFFICE.lat},${OFFICE.lng},5000`,
    );
    expect(theirs.body.items).toEqual([]);
  });

  it('checks a person in within the radius, and keeps where they were', async () => {
    const res = await owner.call('POST', `/api/meetings/${ids.office}/check-in`, {
      at: NEARBY,
      accuracyM: 15,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.value).toMatchObject({
      meetingId: ids.office,
      location: NEARBY,
      accuracyM: 15,
    });
    expect(res.body.value.distanceM).toBeGreaterThan(90);
    expect(res.body.value.distanceM).toBeLessThan(110);
    const list = await owner.call('GET', `/api/meetingCheckIns?meetingId=${ids.office}`);
    expect(list.body.items).toHaveLength(1);
  });

  it('refuses a check-in too far away, too imprecise, or with no place, and audits it', async () => {
    const far = await owner.call('POST', `/api/meetings/${ids.office}/check-in`, {
      at: ACROSS_TOWN,
    });
    expect(far.status).toBe(403);
    expect(far.body.rule).toBe('outside_geofence');
    expect(far.body.reason).toMatch(/^You are 3\d{3} m from Office review/);
    const vague = await owner.call('POST', `/api/meetings/${ids.office}/check-in`, {
      at: OFFICE,
      accuracyM: 900,
    });
    expect(vague.body.rule).toBe('imprecise_location');
    const nowhere = await owner.call('POST', `/api/meetings/${ids.nowhere}/check-in`, {
      at: OFFICE,
    });
    expect(nowhere.body.rule).toBe('no_place');
    const { rows } = await pool.query(
      "select rule from audit.events where tenant_id = $1 and action = 'meeting.check-in' and outcome = 'denied'",
      [tenantId],
    );
    expect(rows.map((r) => r.rule).sort()).toEqual([
      'imprecise_location',
      'no_place',
      'outside_geofence',
    ]);
  });

  it("another business's meeting is not found; staff reach only their own", async () => {
    const res = await stranger.call('POST', `/api/meetings/${ids.office}/check-in`, { at: OFFICE });
    expect(res.status).toBe(404);
    const staffRes = await staff.call(
      'POST',
      `/api/meetings/${ids.office}/check-in`,
      { at: OFFICE },
      inTenant,
    );
    expect(staffRes.status).toBe(404);
    expect(
      (await stranger.call('GET', `/api/meetingCheckIns?meetingId=${ids.office}`)).body.items,
    ).toEqual([]);
  });

  it('only people check in: the assistant has no position and no route', async () => {
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const res = await asks('POST', `/api/meetings/${ids.office}/check-in`, { at: OFFICE });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('humans_only');
    expect((await asks('GET', '/api/meetingCheckIns')).status).toBe(403);
    // No check-in is written but through the command.
    const direct = await owner.call('POST', '/api/meetingCheckIns', {
      meetingId: ids.office,
      location: OFFICE,
      distanceM: 0,
    });
    expect(direct.status).toBe(404);
  });
});

describe('order totals', () => {
  const lines = (price: string) => [
    { ref: '1', kind: 'line', title: 'Item', quantity: 1, unitPrice: price },
  ];

  beforeAll(async () => {
    await pool.query(`update app.tenants set settings = settings || $2::jsonb where id = $1`, [
      tenantId,
      JSON.stringify({ money: { currency: 'INR' } }),
    ]);
    for (const [title, price] of [
      ['First', '100.00'],
      ['Second', '250.50'],
      ['Third', '40.00'],
    ]) {
      const res = await owner.call('POST', '/api/orders/save', { title, items: lines(price) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const third = (await owner.call('GET', '/api/orders?q=Third')).body.items[0];
    const cancel = await owner.call('POST', `/api/transitions/orders/${third.id}/cancel`, {});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
  });

  it('by status: counts and totals, per currency', async () => {
    const res = await owner.call('GET', '/api/orders/summary?groupBy=status&sum=total');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([
      {
        key: { status: 'cancelled', currency: 'INR' },
        count: 1,
        sum: { total: { minor: 4000, currency: 'INR' } },
      },
      {
        key: { status: 'draft', currency: 'INR' },
        count: 2,
        sum: { total: { minor: 35050, currency: 'INR' } },
      },
    ]);
  });

  it('by month in the business’s time zone, newest first', async () => {
    const res = await owner.call(
      'GET',
      '/api/orders/summary?groupBy=createdAt:month&sum=total&sort=-key&limit=4',
    );
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
    })
      .format(new Date())
      .slice(0, 7);
    expect(res.body.groups).toEqual([
      {
        key: { createdAt: month, currency: 'INR' },
        count: 3,
        sum: { total: { minor: 39050, currency: 'INR' } },
      },
    ]);
  });

  it("another business's orders are never in the totals", async () => {
    const res = await stranger.call('GET', '/api/orders/summary?sum=total');
    expect(res.body.totals).toEqual([{ key: {}, count: 0, sum: { total: null } }]);
  });

  it('the assistant answers with summarize-orders, shown as tiles it did not type', async () => {
    const res = await owner.chat('orders by status', undefined, ['inline']);
    expect(res.body.toolCalls.map((t: { tool: string }) => t.tool)).toEqual(['summarize-orders']);
    expect(res.body.toolCalls[0].present).toMatchObject({
      kind: 'inline',
      view: 'kpi.row',
      props: { of: { entity: 'orders', query: { groupBy: ['status'], sum: ['total'] } } },
    });
    expect(res.body.reply).toContain('3 orders');
    const text = await owner.chat('order totals by month', undefined, ['text']);
    expect(text.body.toolCalls[0].present.kind).toBe('text');
    expect(text.body.toolCalls[0].present.text).toMatch(/₹/);
  });
});
