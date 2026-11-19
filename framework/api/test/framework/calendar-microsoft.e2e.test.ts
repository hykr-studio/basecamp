// Microsoft 365 / Outlook calendars (B21), on the fixture's appointments: connecting by OAuth
// with PKCE (the in-memory fake Microsoft), records written once to the person's target calendar
// (an extended property finds a retry's event again), changes made in Outlook coming back as
// events through a Graph subscription or by polling, the validation handshake, renewal before
// a subscription lapses, refusals, busy time merged across Google and Microsoft, and the
// person's copy and erasure.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.GOOGLE_CALENDAR_TRANSPORT = 'fake';
process.env.MICROSOFT_CALENDAR_TRANSPORT = 'fake';
process.env.CALENDAR_PROVIDERS = 'google,microsoft';

import { randomUUID } from 'node:crypto';
import { fakeGoogle } from '@hykr/connectors/google-calendar';
import { fakeMicrosoft } from '@hykr/connectors/microsoft-calendar';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CalendarSyncService } from '../../dist/features/calendar/sync.service.js';
import { readZip } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  connectCalendar,
  eventually,
  me,
  Person,
  pool,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { calendarApp } from '../fixture/dist/features/calendar/index.js';

const ms = fakeMicrosoft();
const google = fakeGoogle();
const owner = new Person('Owner MsCal');
const staff = new Person('Staff MsCal');
const sam = new Person('Sam MsCal');
const outsider = new Person('Out MsCal');
let tenantId = '';

const here = () => ({ 'x-tenant-id': tenantId });
const inBusiness = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, here());
const sync = () => server.app?.get(CalendarSyncService, { strict: false }) as CalendarSyncService;

const HOUR = 3_600_000;
const hoursAhead = (h: number) => {
  const d = new Date(Date.now() + h * HOUR);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

const connect = async (p: Person, provider: 'google' | 'microsoft') => {
  const res = await connectCalendar(p, provider, here());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.status).toBe('done');
  return res.body.value as { id: string; provider: string; account: string };
};

/** A sign-in `p` started at Microsoft, through the callback: what the app is handed. */
async function signIn(p: Person) {
  const res = await p.call('POST', '/api/calendar/microsoft/start', {}, here());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const back = await fetch(res.body.url, { redirect: 'manual' });
  expect(back.status).toBe(302);
  const landing = new URL(back.headers.get('location') ?? '');
  return {
    callback: new URL(res.body.url),
    landing,
    code: landing.searchParams.get('code') ?? '',
    state: landing.searchParams.get('state') ?? '',
  };
}

const connectionOf = async (userId: string, provider: string) =>
  (
    await pool.query(
      'select * from app.calendar_connections where user_id = $1 and tenant_id = $2 and provider = $3',
      [userId, tenantId, provider],
    )
  ).rows[0];

const linkOf = async (connectionId: string, recordId: string) =>
  (
    await pool.query(
      'select * from app.calendar_event_links where connection_id = $1 and resource_id = $2',
      [connectionId, recordId],
    )
  ).rows[0];

/** The record's event in the person's Outlook, found through its link. */
const outlookEvent = async (p: Person, recordId: string) => {
  const conn = await connectionOf(p.id, 'microsoft');
  const link = conn ? await linkOf(conn.id, recordId) : undefined;
  const e = link ? ms.event(p.email, link.external_id) : undefined;
  return e && !e.deleted ? e : undefined;
};

const createAppointment = async (p: Person, body: Record<string, unknown>) => {
  const res = await inBusiness(p)('POST', '/api/appointments', {
    startsAt: hoursAhead(24),
    endsAt: hoursAhead(25),
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.value.id as string;
};

const storedEvents = async (name: string, recordId: string) =>
  (
    await pool.query(
      "select row from app.domain_events where tenant_id = $1 and name = $2 and row->>'recordId' = $3",
      [tenantId, name, recordId],
    )
  ).rows.map((r) => r.row as Record<string, unknown>);

const graphPosts = () =>
  ms.requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/me/events'));

beforeAll(async () => {
  await boot(calendarApp);
  process.env.CALENDAR_PUBLIC_URL = server.base;
  process.env.GOOGLE_CALENDAR_REDIRECT_URL = `${server.base}/api/calendar/google/callback`;
  process.env.MICROSOFT_CALENDAR_REDIRECT_URL = `${server.base}/api/calendar/microsoft/callback`;
  for (const p of [owner, staff, sam, outsider]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(sam, tenantId, ['staff']);
  await setTenantSettings(tenantId, { timeZone: 'UTC' });
});
afterAll(async () => {
  vi.useRealTimers();
  delete process.env.CALENDAR_PROVIDERS;
  delete process.env.MICROSOFT_CALENDAR_TRANSPORT;
  await shutdown();
});

describe('connecting Outlook', () => {
  it('offers both providers', async () => {
    const res = await owner.call('GET', '/api/calendar/providers');
    expect(res.body).toEqual([
      { name: 'google', available: true },
      { name: 'microsoft', available: true },
    ]);
  });

  it('connects through start, callback and complete, once, as the person in their business', async () => {
    const started = await signIn(owner);
    expect(started.callback.pathname).toBe('/api/calendar/microsoft/callback');
    expect(started.landing.pathname).toBe('/calendar');
    expect(started.landing.searchParams.get('provider')).toBe('microsoft');
    // Someone else cannot finish it, and trying uses it up.
    const stolen = await inBusiness(staff)('POST', '/api/calendar/microsoft/complete', {
      code: started.code,
      state: started.state,
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body.rule).toBe('calendar_sign_in_not_yours');
    const again = await signIn(owner);
    // A Microsoft sign-in is not Google's to finish.
    const wrong = await inBusiness(owner)('POST', '/api/calendar/google/complete', {
      code: again.code,
      state: again.state,
    });
    expect(wrong.body.rule).toBe('calendar_sign_in_invalid');
    // Not in another business either.
    const elsewhere = await signIn(owner);
    const other = await owner.call(
      'POST',
      '/api/calendar/microsoft/complete',
      { code: elsewhere.code, state: elsewhere.state },
      { 'x-tenant-id': (await me(outsider)).tenantId },
    );
    expect(other.status).toBe(403);
    // The assistant never connects a calendar.
    const assistant = asAssistant(`user:${owner.id}`, { 'x-channel': 'app', ...here() });
    expect((await assistant('POST', '/api/calendar/microsoft/start', {})).status).toBe(403);

    const mine = await signIn(owner);
    const done = await inBusiness(owner)('POST', '/api/calendar/microsoft/complete', {
      code: mine.code,
      state: mine.state,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.value).toMatchObject({
      provider: 'microsoft',
      account: owner.email,
      status: 'active',
    });
    // Single use.
    const twice = await inBusiness(owner)('POST', '/api/calendar/microsoft/complete', {
      code: mine.code,
      state: mine.state,
    });
    expect(twice.body.rule).toBe('calendar_sign_in_invalid');
    const conn = await connectionOf(owner.id, 'microsoft');
    const inbound = await pool.query(
      'select connector from app.integration_connections where id = $1',
      [conn.inbound_connection_id],
    );
    expect(inbound.rows[0].connector).toBe('microsoft-calendar');
    // Graph checked the subscription's address (the handshake) before it made it.
    await eventually(() => ms.subscriptions(owner.email).length === 1);
    await eventually(
      async () => (await inBusiness(owner)('GET', '/api/calendar/connections')).body[0]?.push,
    );
    expect((await inBusiness(owner)('GET', '/api/calendar/connections')).body).toEqual([
      expect.objectContaining({ provider: 'microsoft', writeTo: true }),
    ]);
  });

  it('a work account that needs an admin to consent is told so, at the screen or the exchange', async () => {
    const a = new Person('Consent MsCal');
    await a.signUp();
    await addMember(a, tenantId, ['staff']);
    ms.requireAdminConsent(a.email);
    const res = await a.call('POST', '/api/calendar/microsoft/start', {}, here());
    const back = await fetch(res.body.url, { redirect: 'manual' });
    const landing = new URL(back.headers.get('location') ?? '');
    expect(landing.searchParams.get('error')).toBe('admin_consent_required');

    ms.requireAdminConsent(a.email, 'exchange');
    const started = await a.call('POST', '/api/calendar/microsoft/start', {}, here());
    const back2 = await fetch(started.body.url, { redirect: 'manual' });
    const l2 = new URL(back2.headers.get('location') ?? '');
    const done = await a.call(
      'POST',
      '/api/calendar/microsoft/complete',
      { code: l2.searchParams.get('code'), state: l2.searchParams.get('state') },
      here(),
    );
    expect(done.status).toBe(400);
    expect(done.body.rule).toBe('admin_consent_required');
    expect(done.body.message).toMatch(/administrator/);
  });

  it('an unknown provider is a 404', async () => {
    expect((await inBusiness(owner)('POST', '/api/calendar/caldav/start', {})).status).toBe(404);
  });
});

describe('records in Outlook', () => {
  it('writes a record once even when the answer is lost and the job retries', async () => {
    const before = graphPosts().length;
    ms.loseNextAnswer((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/me/events'));
    const id = await createAppointment(owner, { title: 'Lost answer', place: 'Studio' });
    const e = await eventually(() => outlookEvent(owner, id), 30_000);
    expect(e).toMatchObject({ subject: 'Lost answer', location: 'Studio', timeZone: 'UTC' });
    // One event: the retry found the first by its key and updated it.
    expect(ms.events(owner.email).filter((x) => x.key === e.key && !x.deleted)).toHaveLength(1);
    expect(graphPosts().length - before).toBe(1);
  });

  it('a change updates the event; deleting the record deletes it', async () => {
    const id = await createAppointment(owner, { title: 'Will change' });
    const first = await eventually(() => outlookEvent(owner, id));
    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, {
      title: 'Changed',
      startsAt: hoursAhead(30),
      endsAt: hoursAhead(31),
    });
    await eventually(async () => (await outlookEvent(owner, id))?.subject === 'Changed');
    const now = await outlookEvent(owner, id);
    expect(now?.id).toBe(first.id);
    expect(now?.start).toBe(hoursAhead(30));
    expect(
      ms.requests.some((r) => r.method === 'PATCH' && r.url.endsWith(`/me/events/${first.id}`)),
    ).toBe(true);
    await inBusiness(owner)('DELETE', `/api/appointments/${id}`);
    await eventually(() => ms.event(owner.email, first.id)?.deleted);
  });

  it('writes events in the business zone', async () => {
    await setTenantSettings(tenantId, { timeZone: 'Asia/Kolkata' });
    try {
      const id = await createAppointment(owner, { title: 'Zoned' });
      const e = await eventually(() => outlookEvent(owner, id));
      expect(e.timeZone).toBe('Asia/Kolkata');
      expect(e.start).toBe(hoursAhead(24));
      const sent = ms.requests
        .filter((r) => r.body?.includes('"Zoned"'))
        .map((r) => JSON.parse(r.body ?? '{}'))
        .find((b) => b.start);
      // 5:30 ahead of UTC, on the wall.
      expect(sent.start.dateTime).toBe(
        new Date(Date.parse(hoursAhead(24)) + 5.5 * HOUR).toISOString().slice(0, 19),
      );
    } finally {
      await setTenantSettings(tenantId, { timeZone: 'UTC' });
    }
  });
});

describe('changes made in Outlook', () => {
  let id = '';
  let inboundId = '';

  beforeAll(async () => {
    id = await createAppointment(owner, { title: 'In Outlook' });
    await eventually(() => outlookEvent(owner, id));
    const conn = await connectionOf(owner.id, 'microsoft');
    inboundId = conn.inbound_connection_id;
    await eventually(async () => (await connectionOf(owner.id, 'microsoft')).sync_token);
  });

  it('a moved event comes back as calendar.event_moved, through the subscription', async () => {
    const e = await outlookEvent(owner, id);
    const start = hoursAhead(72);
    ms.edit(owner.email, e?.id as string, { start, end: hoursAhead(73) });
    expect(await ms.push(owner.email)).toEqual([200]);
    const [moved] = await eventually(async () => {
      const found = await storedEvents('calendar.event_moved', id);
      return found.length ? found : undefined;
    });
    expect(moved).toMatchObject({
      entity: 'appointment',
      recordId: id,
      userId: owner.id,
      provider: 'microsoft',
      startsAt: start,
      sentStartsAt: hoursAhead(24),
    });
  });

  it('a deleted event comes back as calendar.event_removed', async () => {
    const e = await outlookEvent(owner, id);
    ms.remove(owner.email, e?.id as string);
    await ms.push(owner.email);
    await eventually(async () => (await storedEvents('calendar.event_removed', id)).length > 0);
  });

  it("answers Graph's validation handshake and refuses a wrong clientState", async () => {
    const token = 'Validation: Testing client application reachability 42 <b>';
    const res = await fetch(
      `${server.base}/webhooks/microsoft-calendar/${inboundId}?validationToken=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'content-type': 'text/plain' } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(token);
    // An unknown connection gets nothing echoed.
    const unknown = await fetch(
      `${server.base}/webhooks/microsoft-calendar/${randomUUID()}?validationToken=x`,
      { method: 'POST' },
    );
    expect(unknown.status).toBe(404);
    expect(await ms.push(owner.email, { clientState: 'x'.repeat(43) })).toEqual([401]);
  });

  it('without a subscription, changes are found by polling', async () => {
    const conn = await connect(sam, 'microsoft');
    await eventually(() => ms.subscriptions(sam.email).length === 1);
    // No channel: the subscription gone and nothing to receive one on.
    await pool.query(
      'update app.calendar_connections set inbound_connection_id = null, channel_id = null, channel_expires_at = null where id = $1',
      [conn.id],
    );
    const rec = await createAppointment(sam, { title: 'Polled' });
    const e = await eventually(() => outlookEvent(sam, rec));
    await sync().maintain();
    ms.edit(sam.email, e.id, { start: hoursAhead(80), end: hoursAhead(81) });
    await sync().maintain();
    const [moved] = await eventually(async () => {
      const found = await storedEvents('calendar.event_moved', rec);
      return found.length ? found : undefined;
    });
    expect(moved).toMatchObject({ provider: 'microsoft', startsAt: hoursAhead(80) });
  });

  it('a lost delta cursor starts again from the whole window, noting nothing', async () => {
    ms.expireDelta(sam.email);
    await sync().maintain();
    const conn = await connectionOf(sam.id, 'microsoft');
    expect(conn.last_error).toBeNull();
    expect(conn.sync_token).toMatch(/deltatoken=/);
  });
});

describe('renewing subscriptions', () => {
  it('renews a subscription before it lapses (a moved clock), and deletes the old one', async () => {
    const before = await connectionOf(owner.id, 'microsoft');
    const [old] = ms.subscriptions(owner.email);
    expect(old.id).toBe(before.channel_id);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2.5 * 24 * HOUR });
    try {
      await sync().maintain();
    } finally {
      vi.useRealTimers();
    }
    const after = await connectionOf(owner.id, 'microsoft');
    expect(after.channel_id).not.toBe(old.id);
    expect(ms.subscriptions(owner.email).map((s) => s.id)).toEqual([after.channel_id]);
    expect(after.channel_expires_at.getTime()).toBeGreaterThan(before.channel_expires_at.getTime());
  });

  it('a refused refresh marks the connection needs_reauth', async () => {
    ms.refuseRefresh(sam.email);
    // Past any token the renewal above refreshed.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 4 * 24 * HOUR });
    try {
      await sync().pullChanges((await connectionOf(sam.id, 'microsoft')).id);
    } finally {
      vi.useRealTimers();
    }
    const conn = await connectionOf(sam.id, 'microsoft');
    expect(conn.status).toBe('needs_reauth');
    expect(conn.last_error).toMatch(/Microsoft no longer accepts/);
    const busy = await sam.call(
      'GET',
      `/api/calendar/busy?from=${encodeURIComponent(hoursAhead(1))}&to=${encodeURIComponent(hoursAhead(5))}`,
      undefined,
      here(),
    );
    expect(busy.body.connected).toBe(false);
  });
});

describe('Google and Microsoft together', () => {
  let googleId = '';
  let microsoftId = '';
  let recordId = '';

  beforeAll(async () => {
    microsoftId = (await connectionOf(owner.id, 'microsoft')).id;
    googleId = (await connect(owner, 'google')).id;
    recordId = await createAppointment(owner, { title: 'Where does it go' });
    await eventually(() => outlookEvent(owner, recordId));
  });

  it('lists both; the first connected is written to, the second is only read', async () => {
    const list = (await inBusiness(owner)('GET', '/api/calendar/connections')).body;
    expect(list).toEqual([
      expect.objectContaining({ id: microsoftId, provider: 'microsoft', writeTo: true }),
      expect.objectContaining({ id: googleId, provider: 'google', writeTo: false }),
    ]);
    await new Promise((r) => setTimeout(r, 1000));
    const inGoogle = google
      .events(owner.email)
      .filter((e) => e.extendedProperties?.private?.record === recordId);
    expect(inGoogle).toEqual([]);
  });

  it('free time leaves out busy time from both calendars', async () => {
    ms.addOwnEvent(owner.email, {
      start: hoursAhead(102),
      end: hoursAhead(103),
      subject: 'Dentist (private)',
    });
    google.addOwnEvent(owner.email, { start: hoursAhead(105), end: hoursAhead(106) });
    const from = encodeURIComponent(hoursAhead(100));
    const to = encodeURIComponent(hoursAhead(110));
    const busy = await inBusiness(owner)('GET', `/api/calendar/busy?from=${from}&to=${to}`);
    expect(busy.body).toEqual({
      connected: true,
      busy: [
        { start: hoursAhead(102), end: hoursAhead(103) },
        { start: hoursAhead(105), end: hoursAhead(106) },
      ],
    });
    const free = await inBusiness(owner)(
      'GET',
      `/api/calendar/free?from=${from}&to=${to}&minutes=60`,
    );
    const starts = free.body.slots.map((s: { start: string }) => s.start);
    expect(starts).toContain(hoursAhead(100));
    expect(starts).toContain(hoursAhead(103));
    expect(starts).not.toContain(hoursAhead(102));
    expect(starts).not.toContain(hoursAhead(105));
  });

  it('picking Google as the target moves the events there', async () => {
    const assistant = asAssistant(`user:${owner.id}`, { 'x-channel': 'app', ...here() });
    expect(
      (await assistant('PATCH', `/api/calendar/connections/${googleId}`, { writeTo: true })).status,
    ).toBe(403);
    expect(
      (await inBusiness(staff)('PATCH', `/api/calendar/connections/${googleId}`, { writeTo: true }))
        .status,
    ).toBe(404);
    const res = await inBusiness(owner)('PATCH', `/api/calendar/connections/${googleId}`, {
      writeTo: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await eventually(
      () =>
        google
          .events(owner.email)
          .find(
            (e) => e.extendedProperties?.private?.record === recordId && e.status === 'confirmed',
          ),
      20_000,
    );
    await eventually(async () => !(await outlookEvent(owner, recordId)));
    const list = (await inBusiness(owner)('GET', '/api/calendar/connections')).body;
    expect(list.find((c: { id: string }) => c.id === googleId).writeTo).toBe(true);
    expect(list.find((c: { id: string }) => c.id === microsoftId).writeTo).toBe(false);
  });

  it('reads only free and busy: no subject of the person’s own events is stored', async () => {
    await sync().pullChanges(microsoftId);
    const tables = [
      'app.calendar_event_links',
      'app.calendar_connections',
      'app.domain_events',
      'app.integration_inbound',
      'audit.events',
    ];
    for (const t of tables) {
      const { rows } = await pool.query(
        `select count(*)::int as n from ${t} x where x::text like $1`,
        ['%Dentist (private)%'],
      );
      expect(rows[0].n, t).toBe(0);
    }
  });
});

describe("the person's data", () => {
  it('the copy lists the Microsoft connection; erasure deletes it and cleans up Outlook', async () => {
    const mia = new Person('Mia MsCal');
    await mia.signUp();
    await addMember(mia, tenantId, ['staff']);
    const miaTenant = tenantId;
    const res = await connectCalendar(mia, 'microsoft', { 'x-tenant-id': miaTenant });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await eventually(() => ms.subscriptions(mia.email).length === 1);
    const appt = await mia.call(
      'POST',
      '/api/appointments',
      { title: 'Mine', startsAt: hoursAhead(24), endsAt: hoursAhead(25) },
      { 'x-tenant-id': miaTenant },
    );
    expect(appt.status).toBe(201);
    await eventually(() => ms.events(mia.email).some((e) => !e.deleted));

    const exported = await mia.call(
      'POST',
      '/api/privacy/requests',
      { kind: 'export' },
      { 'x-tenant-id': miaTenant },
    );
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const done = await eventually(async () => {
      const r = await mia.call(
        'GET',
        `/api/privacy/requests/${exported.body.value.id}`,
        undefined,
        {
          'x-tenant-id': miaTenant,
        },
      );
      return ['completed', 'failed', 'refused'].includes(r.body?.status) ? r.body : undefined;
    }, 20_000);
    expect(done.status).toBe('completed');
    const got = await mia.call('GET', `/api/files/${done.files[0]}`, undefined, {
      'x-tenant-id': miaTenant,
    });
    const zip = readZip(
      Buffer.from(await (await fetch(`${server.base}${got.body.url}`)).arrayBuffer()),
    );
    expect(
      JSON.parse(zip.get('features/calendarConnections.json')?.toString('utf8') ?? '[]'),
    ).toMatchObject([{ provider: 'microsoft', account: mia.email }]);
    const everything = [...zip.values()].map((b) => b.toString('utf8')).join('\n');
    expect(everything).not.toMatch(/fake-ms-(rt|at)-/);

    const erased = await mia.call(
      'POST',
      '/api/privacy/requests',
      { kind: 'erase' },
      { 'x-tenant-id': miaTenant },
    );
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    await eventually(async () => {
      const { rows } = await pool.query(
        'select count(*)::int as n from app.calendar_connections where tenant_id = $1 and user_id = $2',
        [miaTenant, mia.id],
      );
      return rows[0].n === 0;
    }, 20_000);
    await eventually(() => ms.subscriptions(mia.email).length === 0);
    await eventually(() => ms.events(mia.email).every((e) => e.deleted));
  });
});
