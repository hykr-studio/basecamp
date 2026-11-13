// Calendars and calls (B17), on the fixture's appointments (fixture/src/features/calendar):
// connecting a Google calendar by OAuth (the in-memory fake Google), records reaching it as each
// person may read them, changes made in Google coming back as events, busy and free time, invites
// by email with an .ics (Mailpit), private feeds, and the call log with a fixture provider.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.GOOGLE_CALENDAR_TRANSPORT = 'fake';

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fakeGoogle } from '@hykr/connectors/google-calendar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailerService } from '../../dist/channels/notify/mailer.service.js';
import {
  addMember,
  asAssistant,
  boot,
  connectGoogleCalendar,
  eventually,
  me,
  Person,
  pool,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { calendarApp, dialled, REFUSED_NUMBER } from '../fixture/dist/features/calendar/index.js';

const google = fakeGoogle();
const owner = new Person('Owner Cal');
const staff = new Person('Staff Cal');
const admin = new Person('Admin Cal');
const other = new Person('Other Cal');
let tenantId = '';

const inBusiness = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });

const HOUR = 3_600_000;
/** Whole hours from now, on the hour, as ISO. */
const hoursAhead = (h: number) => {
  const d = new Date(Date.now() + h * HOUR);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

/** Connect a person's calendar as the app does: consent, the callback, the app finishing it. */
async function connect(p: Person, inTenant = true) {
  const res = await connectGoogleCalendar(p, inTenant ? { 'x-tenant-id': tenantId } : {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.status).toBe('done');
  return res;
}

/** A sign-in `p` started, through Google and the callback: what the app is handed. */
async function signIn(p: Person, headers: Record<string, string> = {}) {
  const res = await p.call('POST', '/api/calendar/connections', { provider: 'google' }, headers);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const back = await fetch(res.body.url, { redirect: 'manual' });
  expect(back.status).toBe(302);
  const landing = new URL(back.headers.get('location') ?? '');
  return {
    consent: new URL(res.body.url),
    landing,
    code: landing.searchParams.get('code') ?? '',
    state: landing.searchParams.get('state') ?? '',
  };
}

const complete = (
  p: Person,
  body: { code: string; state: string },
  headers: Record<string, string> = {},
) => p.call('POST', '/api/calendar/google/complete', body, headers);

/** How many times the API asked Google for tokens (code exchanges and refreshes). */
const tokenRequests = () =>
  google.requests.filter((r) => r.url.startsWith(google.endpoints.token)).length;

const connectionsOf = async (userId: string) =>
  (
    await pool.query(
      'select id, account, updated_at from app.calendar_connections where user_id = $1',
      [userId],
    )
  ).rows;

const events = (email: string) =>
  google.events(email).filter((e) => e.extendedProperties?.private?.basecamp === '1');
const eventFor = (email: string, recordId: string) =>
  events(email).find((e) => e.extendedProperties?.private?.record === recordId);

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

/** Mailpit's messages to one address, newest first, with their raw text. */
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const messages = ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages;
  return Promise.all(
    messages.map(async (m) => ({
      ...m,
      raw: await (await fetch(`http://localhost:8025/api/v1/message/${m.ID}/raw`)).text(),
    })),
  );
}
const unfolded = (raw: string) => raw.replace(/\r\n[ \t]/g, '');

beforeAll(async () => {
  await boot(calendarApp);
  process.env.CALENDAR_PUBLIC_URL = server.base;
  process.env.GOOGLE_CALENDAR_REDIRECT_URL = `${server.base}/api/calendar/google/callback`;
  for (const p of [owner, staff, admin, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(admin, tenantId, ['admin']);
});
afterAll(shutdown);

describe('connecting a calendar', () => {
  it('offers Google', async () => {
    const res = await owner.call('GET', '/api/calendar/providers');
    expect(res.body).toEqual([{ name: 'google', available: true }]);
  });

  it('asks Google for offline access with PKCE, as the person only', async () => {
    const assistant = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    expect(
      (await assistant('POST', '/api/calendar/connections', { provider: 'google' })).status,
    ).toBe(403);
    const res = await owner.call('POST', '/api/calendar/connections', { provider: 'google' });
    const back = new URL(res.body.url);
    expect(back.pathname).toBe('/api/calendar/google/callback');
    expect(back.searchParams.get('code')).toBeTruthy();
    // The state is a random token: who started it and the PKCE verifier stay on the server.
    const state = back.searchParams.get('state') ?? '';
    expect(state).toMatch(/^cs[A-Za-z0-9_-]{43}$/);
    const { rows } = await pool.query(
      'select user_id, tenant_id, verifier_sealed from app.calendar_oauth_states where state_hash = $1',
      [createHash('sha256').update(state).digest('hex')],
    );
    expect(rows).toEqual([expect.objectContaining({ user_id: owner.id, tenant_id: tenantId })]);
    expect(rows[0].verifier_sealed).toMatch(/^v1\./);
  });

  it('exchanges the code only when the app finishes it; stores the grant sealed, audited without a token', async () => {
    const before = tokenRequests();
    const started = await signIn(owner);
    // The callback hands the code and the state on to the app, and asks Google for nothing.
    expect(started.landing.pathname).toBe('/calendar');
    expect(started.code).toBeTruthy();
    expect(started.state).toMatch(/^cs/);
    expect(tokenRequests()).toBe(before);
    const done = await complete(owner, started);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({
      status: 'done',
      value: { provider: 'google', account: owner.email, status: 'active' },
    });
    expect(JSON.stringify(done.body)).not.toMatch(/fake-(rt|at)-|v1\./);
    expect(tokenRequests()).toBe(before + 1);
    const { rows } = await pool.query(
      'select id, account, tokens_sealed, inbound_connection_id from app.calendar_connections where tenant_id = $1 and user_id = $2',
      [tenantId, owner.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe(owner.email);
    expect(rows[0].tokens_sealed).toMatch(/^v1\./);
    expect(rows[0].tokens_sealed).not.toContain('fake-rt-');
    const audit = await pool.query(
      "select outcome, after::text as after from audit.events where action = 'calendar.connection.connect' and resource_id = $1",
      [rows[0].id],
    );
    expect(audit.rows.map((r) => r.outcome)).toContain('committed');
    expect(JSON.stringify(audit.rows)).not.toMatch(/fake-(rt|at)-/);
    // Its push inbox is a connection of the integration bus.
    const inbound = await pool.query(
      'select connector from app.integration_connections where id = $1',
      [rows[0].inbound_connection_id],
    );
    expect(inbound.rows[0].connector).toBe('google-calendar');
    const list = await owner.call('GET', '/api/calendar/connections');
    expect(list.body).toEqual([
      expect.objectContaining({ provider: 'google', account: owner.email, status: 'active' }),
    ]);
    // A sign-in is used once.
    expect((await complete(owner, started)).body.rule).toBe('calendar_sign_in_invalid');
    // The channel opens once the connection is looked after.
    await eventually(() => google.channels(owner.email).length === 1);
    await eventually(
      async () => (await owner.call('GET', '/api/calendar/connections')).body[0].push,
    );
  });

  it("refuses to finish someone else's sign-in, and nothing is connected", async () => {
    // The owner starts a sign-in and sends its consent link to someone else, who agrees: their
    // browser comes back to the app with the code, under their own session.
    const ownerBefore = await connectionsOf(owner.id);
    const before = tokenRequests();
    const started = await signIn(owner);
    const res = await complete(other, started);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden', rule: 'calendar_sign_in_not_yours' });
    // Google was not asked for tokens, and no calendar was connected to either of them.
    expect(tokenRequests()).toBe(before);
    expect(await connectionsOf(other.id)).toEqual([]);
    expect(await connectionsOf(owner.id)).toEqual(ownerBefore);
    // The refusal used the sign-in up: the one who started it cannot finish it either.
    const late = await complete(owner, started);
    expect(late.status).toBe(400);
    expect(late.body.rule).toBe('calendar_sign_in_invalid');
    expect(tokenRequests()).toBe(before);
    expect(await connectionsOf(owner.id)).toEqual(ownerBefore);
  });

  it('is finished only by a signed-in person, in the business it was started in', async () => {
    const started = await signIn(owner);
    // No session: the sign-in is not touched.
    const anonymous = await fetch(`${server.base}/api/calendar/google/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: JSON.stringify({ code: started.code, state: started.state }),
    });
    expect(anonymous.status).toBe(401);
    // The assistant never finishes one.
    const assistant = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    expect((await assistant('POST', '/api/calendar/google/complete', { ...started })).status).toBe(
      403,
    );
    // The same person, in another business: refused, and the sign-in is used up.
    const staffStarted = await signIn(staff, { 'x-tenant-id': tenantId });
    const elsewhere = await complete(staff, staffStarted);
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.rule).toBe('calendar_sign_in_other_business');
    expect(await connectionsOf(staff.id)).toEqual([]);
    expect((await complete(staff, staffStarted, { 'x-tenant-id': tenantId })).body.rule).toBe(
      'calendar_sign_in_invalid',
    );
  });

  it('refuses a state that was changed or is old, and stops when Google refuses', async () => {
    const started = await signIn(owner);
    // A changed state: the callback knows no such sign-in, and nor does finishing it.
    const tampered = new URL(started.consent);
    const last = started.state.endsWith('A') ? 'B' : 'A';
    tampered.searchParams.set('state', `${started.state.slice(0, -1)}${last}`);
    const back = await fetch(tampered, { redirect: 'manual' });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toContain('error=sign_in_expired');
    const changed = await complete(owner, { code: started.code, state: `${started.state}x` });
    expect(changed.status).toBe(400);
    expect(changed.body.rule).toBe('calendar_sign_in_invalid');
    // A code Google does not know.
    const badCode = await complete(owner, { code: 'not-a-code', state: started.state });
    expect(badCode.status).toBe(400);
    expect(badCode.body.rule).toBe('google_refused');
    // Too old.
    const old = await signIn(owner);
    await pool.query(
      "update app.calendar_oauth_states set expires_at = now() - interval '1 minute' where state_hash = $1",
      [createHash('sha256').update(old.state).digest('hex')],
    );
    expect((await complete(owner, old)).body.rule).toBe('calendar_sign_in_invalid');
    // The person said no at Google: the app is told, and the sign-in is over.
    const no = await signIn(owner);
    const denied = new URL(no.consent);
    denied.searchParams.delete('code');
    denied.searchParams.set('error', 'access_denied');
    const deniedBack = await fetch(denied, { redirect: 'manual' });
    expect(deniedBack.headers.get('location')).toContain('error=access_denied');
    expect((await complete(owner, no)).body.rule).toBe('calendar_sign_in_invalid');
  });

  it('finished again with the same idempotency-key, answers the first answer: one exchange', async () => {
    const started = await signIn(owner);
    const before = tokenRequests();
    const key = { 'x-tenant-id': tenantId, 'idempotency-key': `complete-${started.state}` };
    const body = { code: started.code, state: started.state };
    const first = await complete(owner, body, key);
    const again = await complete(owner, body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.value.id).toBe(first.body.value.id);
    expect(tokenRequests()).toBe(before + 1);
  });

  it('connects the other people of the test, each in their own calendar', async () => {
    await connect(staff);
    await connect(admin);
    await connect(other, false);
    expect((await inBusiness(staff)('GET', '/api/calendar/connections')).body).toHaveLength(1);
  });

  it("is the person's own: someone else's connection is a 404", async () => {
    const [mine] = (await owner.call('GET', '/api/calendar/connections')).body;
    expect((await other.call('DELETE', `/api/calendar/connections/${mine.id}`)).status).toBe(404);
    expect((await inBusiness(admin)('DELETE', `/api/calendar/connections/${mine.id}`)).status).toBe(
      404,
    );
  });
});

describe('records in calendars', () => {
  it('a new record reaches its owner’s calendar, with every field they see', async () => {
    const id = await createAppointment(owner, {
      title: 'Planning',
      place: '12 First Street',
      notes: 'Bring the samples',
    });
    const e = await eventually(() => eventFor(owner.email, id));
    expect(e).toMatchObject({
      summary: 'Planning',
      location: '12 First Street',
      description: 'Bring the samples',
      status: 'confirmed',
    });
    expect(e.extendedProperties?.private).toMatchObject({
      entity: 'appointment',
      tenant: tenantId,
    });
  });

  it('a field hidden from the person never reaches their calendar', async () => {
    const id = await createAppointment(staff, { title: 'Staff call', notes: 'Hidden from staff' });
    const e = await eventually(() => eventFor(staff.email, id));
    expect(e.summary).toBe('Staff call');
    expect(e.description).toBeUndefined();
  });

  it('reaches a second person only if they may read it', async () => {
    // Staff read their own appointments only: assigned one, they still cannot read it.
    const toStaff = await createAppointment(owner, { title: 'For staff', assigneeId: staff.id });
    const toAdmin = await createAppointment(owner, {
      title: 'For admin',
      assigneeId: admin.id,
      notes: 'Admins see notes',
    });
    await eventually(() => eventFor(admin.email, toAdmin));
    expect(eventFor(admin.email, toAdmin)?.description).toBe('Admins see notes');
    await eventually(() => eventFor(owner.email, toStaff));
    expect(eventFor(staff.email, toStaff)).toBeUndefined();
  });

  it("another business's records never reach this business's calendars", async () => {
    const theirs = await other.call('POST', '/api/appointments', {
      title: 'Theirs',
      startsAt: hoursAhead(30),
      endsAt: hoursAhead(31),
    });
    const id = theirs.body.value.id;
    await eventually(() => eventFor(other.email, id));
    expect(eventFor(owner.email, id)).toBeUndefined();
    expect(eventFor(admin.email, id)).toBeUndefined();
  });

  it('follows changes, sends nothing for an unchanged record, and leaves when cancelled or deleted', async () => {
    const id = await createAppointment(owner, { title: 'Moving' });
    await eventually(() => eventFor(owner.email, id));
    const moved = await inBusiness(owner)('PATCH', `/api/appointments/${id}`, {
      title: 'Moved',
      startsAt: hoursAhead(48),
      endsAt: hoursAhead(49),
    });
    expect(moved.status).toBe(200);
    await eventually(() => eventFor(owner.email, id)?.summary === 'Moved');
    expect(eventFor(owner.email, id)?.start?.dateTime).toBe(hoursAhead(48));

    const puts = () =>
      google.requests.filter(
        (r) => r.method === 'PUT' && r.url.includes(eventFor(owner.email, id)?.id ?? '-'),
      ).length;
    const before = puts();
    // A change the calendar does not show (the same title): nothing goes to Google.
    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, { title: 'Moved' });
    await new Promise((r) => setTimeout(r, 2500));
    expect(puts()).toBe(before);

    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, { status: 'cancelled' });
    await eventually(() => eventFor(owner.email, id)?.status === 'cancelled');
    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, { status: 'booked' });
    await eventually(() => eventFor(owner.email, id)?.status === 'confirmed');
    expect((await inBusiness(owner)('DELETE', `/api/appointments/${id}`)).status).toBe(200);
    await eventually(() => eventFor(owner.email, id)?.status === 'cancelled');
    const { rows } = await pool.query(
      'select count(*)::int as n from app.calendar_event_links where resource_id = $1',
      [id],
    );
    expect(rows[0].n).toBe(0);
  });

  const linksOf = async (id: string) =>
    (
      await pool.query(
        'select count(*)::int as n from app.calendar_event_links where resource_id = $1',
        [id],
      )
    ).rows[0].n as number;
  const saves = (text: string) => (r: { method: string; body?: string }) =>
    r.method === 'PUT' && (r.body ?? '').includes(text);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("takes turns per record: a slow save never brings back a record that's gone", async () => {
    const title = `Short-lived ${Date.now()}`;
    // Its first save waits in Google while the record is deleted.
    google.delayNext(saves(title), 1500);
    const id = await createAppointment(owner, { title });
    await eventually(() => google.requests.some(saves(title)));
    expect((await inBusiness(owner)('DELETE', `/api/appointments/${id}`)).status).toBe(200);
    await eventually(() => eventFor(owner.email, id)?.status === 'cancelled');
    await eventually(async () => (await linksOf(id)) === 0);
    await pause(1000);
    expect(eventFor(owner.email, id)?.status).toBe('cancelled');
    expect(await linksOf(id)).toBe(0);
  });

  it('takes turns per record: a slow save never overwrites a later change', async () => {
    const id = await createAppointment(owner, { title: `Twice ${Date.now()}` });
    await eventually(() => eventFor(owner.email, id));
    const first = hoursAhead(60);
    const second = hoursAhead(70);
    // The first move's save waits in Google; the second move comes meanwhile.
    google.delayNext(saves(first), 1500);
    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, {
      startsAt: first,
      endsAt: hoursAhead(61),
    });
    await eventually(() => google.requests.some(saves(first)));
    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, {
      startsAt: second,
      endsAt: hoursAhead(71),
    });
    await eventually(() => eventFor(owner.email, id)?.start?.dateTime === second);
    await pause(2000);
    expect(eventFor(owner.email, id)?.start?.dateTime).toBe(second);
    const { rows } = await pool.query(
      'select sent_starts_at from app.calendar_event_links where resource_id = $1',
      [id],
    );
    expect(new Date(rows[0].sent_starts_at).toISOString()).toBe(second);
  });
});

describe('changes made in Google', () => {
  let id = '';
  let inboundId = '';

  beforeAll(async () => {
    id = await createAppointment(owner, { title: 'In Google' });
    await eventually(() => eventFor(owner.email, id));
    const { rows } = await pool.query(
      'select inbound_connection_id from app.calendar_connections where user_id = $1 and tenant_id = $2',
      [owner.id, tenantId],
    );
    inboundId = rows[0].inbound_connection_id;
    // Where changes are read from starts after the record went in.
    await eventually(async () => {
      const r = await pool.query(
        'select sync_token from app.calendar_connections where user_id = $1 and tenant_id = $2',
        [owner.id, tenantId],
      );
      return r.rows[0].sync_token;
    });
  });

  it('a moved event comes back as calendar.event_moved, through the push channel', async () => {
    const e = eventFor(owner.email, id);
    const sent = e?.start?.dateTime;
    const start = hoursAhead(72);
    google.edit(owner.email, e?.id as string, {
      start: { dateTime: start },
      end: { dateTime: hoursAhead(73) },
    });
    expect(await google.push(owner.email)).toEqual([200]);
    const [moved] = await eventually(async () => {
      const found = await storedEvents('calendar.event_moved', id);
      return found.length ? found : undefined;
    });
    expect(moved).toMatchObject({
      entity: 'appointment',
      recordId: id,
      userId: owner.id,
      startsAt: start,
      sentStartsAt: sent,
    });
    // Stored once, handled as the system.
    const inbound = await pool.query(
      "select status, handled from app.integration_inbound where connection_id = $1 and type = 'calendar.changed'",
      [inboundId],
    );
    expect(inbound.rows.some((r) => r.status === 'processed')).toBe(true);
  });

  it('a deleted event comes back as calendar.event_removed, and stays out until the record changes', async () => {
    google.remove(owner.email, eventFor(owner.email, id)?.id as string);
    await google.push(owner.email);
    await eventually(async () => (await storedEvents('calendar.event_removed', id)).length > 0);
    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, { title: 'Back again' });
    await eventually(() => eventFor(owner.email, id)?.status === 'confirmed');
    expect(eventFor(owner.email, id)?.summary).toBe('Back again');
  });

  it('a notification with the wrong token is 401; an unknown connection 404', async () => {
    const [ch] = google.channels(owner.email);
    const post = (path: string, token: string) =>
      fetch(`${server.base}${path}`, {
        method: 'POST',
        headers: {
          'x-goog-channel-id': ch.id,
          'x-goog-channel-token': token,
          'x-goog-resource-id': ch.resourceId,
          'x-goog-resource-state': 'exists',
          'x-goog-message-number': '999',
        },
      });
    expect((await post(`/webhooks/google-calendar/${inboundId}`, 'x'.repeat(43))).status).toBe(401);
    expect((await post(`/webhooks/google-calendar/${randomUUID()}`, ch.token)).status).toBe(404);
  });
});

describe('busy and free time', () => {
  const from = () => hoursAhead(100);
  const to = () => hoursAhead(110);

  // Slots start on the hour of the business's zone: UTC here, so they match the hours above.
  beforeAll(() => setTenantSettings(tenantId, { timeZone: 'UTC' }));

  it("reads busy times from the person's calendar, and free slots around them", async () => {
    google.addOwnEvent(owner.email, { start: hoursAhead(102), end: hoursAhead(104) });
    const busy = await owner.call(
      'GET',
      `/api/calendar/busy?from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}`,
    );
    expect(busy.body).toEqual({
      connected: true,
      busy: [{ start: hoursAhead(102), end: hoursAhead(104) }],
    });
    const free = await owner.call(
      'GET',
      `/api/calendar/free?from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}&minutes=60`,
    );
    const starts = free.body.slots.map((s: { start: string }) => s.start);
    expect(starts).toContain(hoursAhead(100));
    expect(starts).toContain(hoursAhead(104));
    expect(starts).not.toContain(hoursAhead(102));
    expect(starts).not.toContain(hoursAhead(103));
    expect(free.body.timeZone).toBe('UTC');
  });

  it("keeps to the business's open hours and holidays, unless hours are asked for", async () => {
    // Ten days on, where no test put anything in the calendar.
    const day = new Date(Date.now() + 240 * HOUR).toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 24 * HOUR).toISOString();
    const q = (extra = '') =>
      `/api/calendar/free?from=${day}T00:00:00Z&to=${encodeURIComponent(next)}&minutes=60${extra}`;
    const starts = async (extra = '') =>
      (await owner.call('GET', q(extra))).body.slots.map((s: { start: string }) =>
        s.start.slice(11, 16),
      );
    const intervals = [
      { from: '10:00', to: '12:00' },
      { from: '14:00', to: '15:00' },
    ];
    const week = Object.fromEntries(
      ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, intervals]),
    );
    try {
      await setTenantSettings(tenantId, { businessHours: { week, holidays: [] } });
      expect(await starts()).toEqual(['10:00', '11:00', '14:00']);
      // Hours asked for are the answer's, open or not.
      expect(await starts('&hoursFrom=16:00&hoursTo=18:00')).toEqual(['16:00', '17:00']);
      await setTenantSettings(tenantId, { businessHours: { week, holidays: [day] } });
      expect(await starts()).toEqual([]);
    } finally {
      await setTenantSettings(tenantId, { businessHours: null });
    }
    // No hours of its own: any hour.
    expect((await starts()).slice(0, 3)).toEqual(['00:00', '01:00', '02:00']);
  });

  it("another member's time needs the capability; the assistant reads its person's", async () => {
    const q = `from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}&minutes=30&userId=${owner.id}`;
    expect((await inBusiness(staff)('GET', `/api/calendar/free?${q}`)).status).toBe(403);
    expect((await inBusiness(admin)('GET', `/api/calendar/free?${q}`)).status).toBe(200);
    const outsider = await other.call('GET', `/api/calendar/free?${q}`);
    expect(outsider.status).toBe(404);
    const assistant = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const res = await assistant(
      'GET',
      `/api/calendar/free?from=${encodeURIComponent(from())}&to=${encodeURIComponent(to())}&minutes=60`,
    );
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
  });

  it('a window over 31 days is refused', async () => {
    const res = await owner.call(
      'GET',
      `/api/calendar/busy?from=${encodeURIComponent(hoursAhead(1))}&to=${encodeURIComponent(hoursAhead(24 * 40))}`,
    );
    expect(res.status).toBe(400);
  });
});

describe('invites', () => {
  const guest = `guest-${Date.now()}@example.test`;
  let id = '';

  it('emails an .ics invite (METHOD:REQUEST) and lists it on the record', async () => {
    id = await createAppointment(owner, { title: 'Walkthrough', place: 'Front desk' });
    const res = await inBusiness(owner)('POST', '/api/calendar/invites', {
      entity: 'appointment',
      id,
      to: [{ email: guest, name: 'Guest' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.value.invites[0]).toMatchObject({ email: guest, status: 'queued' });
    const [mail] = await eventually(async () => {
      const m = await mailTo(guest);
      return m.length ? m : undefined;
    });
    expect(mail.Subject).toBe('Invitation: Walkthrough');
    const raw = unfolded(mail.raw);
    expect(raw).toContain('METHOD:REQUEST');
    expect(raw).toContain('SUMMARY:Walkthrough');
    expect(raw).toContain('SEQUENCE:0');
    expect(raw).toContain(`UID:appointment-${id}@`);
    const list = await inBusiness(owner)(
      'GET',
      `/api/calendar/invites?entity=appointment&id=${id}`,
    );
    await eventually(
      async () =>
        (await inBusiness(owner)('GET', `/api/calendar/invites?entity=appointment&id=${id}`)).body
          .items[0].status === 'sent',
    );
    expect(list.body.items).toHaveLength(1);
  });

  it('moving the record sends an update; deleting it a cancellation', async () => {
    await inBusiness(owner)('PATCH', `/api/appointments/${id}`, {
      startsAt: hoursAhead(50),
      endsAt: hoursAhead(51),
    });
    const update = await eventually(async () =>
      (await mailTo(guest)).find((m) => m.Subject === 'Updated: Walkthrough'),
    );
    expect(unfolded(update.raw)).toContain('SEQUENCE:1');
    await inBusiness(owner)('DELETE', `/api/appointments/${id}`);
    const cancel = await eventually(async () =>
      (await mailTo(guest)).find((m) => m.Subject === 'Cancelled: Walkthrough'),
    );
    expect(unfolded(cancel.raw)).toContain('METHOD:CANCEL');
    expect(unfolded(cancel.raw)).toContain('SEQUENCE:2');
    // Each send to the guest is audited on the invite, as the system, and stored as an event.
    const sends = await eventually(async () => {
      const { rows } = await pool.query(
        `select action, actor_kind, channel, after from audit.events
          where resource_type = 'calendarInvite' and action like 'calendar.invite\\_%'
            and after->'record'->>'id' = $1 order by at, id`,
        [id],
      );
      return rows.length === 3 ? rows : undefined;
    });
    expect(sends.map((r) => [r.action, r.after.sequence, r.after.to])).toEqual([
      ['calendar.invite_sent', 0, guest],
      ['calendar.invite_sent', 1, guest],
      ['calendar.invite_cancelled', 2, guest],
    ]);
    expect(sends.every((r) => r.actor_kind === 'system' && r.channel === 'background')).toBe(true);
    expect(await storedEvents('calendar.invite_cancelled', id)).toHaveLength(1);
  });

  it('a change while an update is on its way goes out after it', async () => {
    const to = `race-${Date.now()}@example.test`;
    const appt = await createAppointment(owner, { title: 'Moved twice' });
    await inBusiness(owner)('POST', '/api/calendar/invites', {
      entity: 'appointment',
      id: appt,
      to: [{ email: to }],
    });
    const statusOf = async () =>
      (await pool.query('select status from app.calendar_invites where resource_id = $1', [appt]))
        .rows[0]?.status as string | undefined;
    await eventually(async () => (await statusOf()) === 'sent');
    // Every email now takes a while: the second move lands while the first update is sent.
    const mailer = server.app?.get(MailerService, { strict: false }) as MailerService;
    const send = mailer.send.bind(mailer);
    mailer.send = async (...args: Parameters<MailerService['send']>) => {
      await new Promise((r) => setTimeout(r, 1500));
      return send(...args);
    };
    const first = hoursAhead(80);
    const second = hoursAhead(90);
    const icsTime = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    try {
      await inBusiness(owner)('PATCH', `/api/appointments/${appt}`, {
        startsAt: first,
        endsAt: hoursAhead(81),
      });
      await eventually(async () => (await statusOf()) === 'sending');
      await inBusiness(owner)('PATCH', `/api/appointments/${appt}`, {
        startsAt: second,
        endsAt: hoursAhead(91),
      });
      const last = await eventually(
        async () =>
          (await mailTo(to)).find((m) => unfolded(m.raw).includes(`DTSTART:${icsTime(second)}`)),
        15_000,
      );
      expect(unfolded(last.raw)).toContain('SEQUENCE:2');
    } finally {
      mailer.send = send;
    }
  });

  it('shows only what the person who invites may see', async () => {
    const mine = await createAppointment(staff, { title: 'Staff invite', notes: 'Secret notes' });
    const to = `staffguest-${Date.now()}@example.test`;
    const res = await inBusiness(staff)('POST', '/api/calendar/invites', {
      entity: 'appointment',
      id: mine,
      to: [{ email: to }],
    });
    expect(res.status).toBe(200);
    const [mail] = await eventually(async () => {
      const m = await mailTo(to);
      return m.length ? m : undefined;
    });
    expect(unfolded(mail.raw)).toContain('SUMMARY:Staff invite');
    expect(mail.raw).not.toContain('Secret notes');
  });

  it("the assistant's invite to someone else waits for approval, and is audited", async () => {
    const appt = await createAppointment(owner, { title: 'Assistant asks' });
    const assistant = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const res = await assistant('POST', '/api/calendar/invites', {
      entity: 'appointment',
      id: appt,
      to: [{ email: `asked-${Date.now()}@example.test` }],
    });
    expect(res.body.status).toBe('needs_approval');
    const audit = await pool.query(
      "select outcome, rule from audit.events where action = 'calendar.invite' and actor_kind = 'agent' order by at desc limit 1",
    );
    expect(audit.rows[0]).toMatchObject({ outcome: 'needs_approval', rule: 'agent_sends_invite' });
  });

  it("another business's record is a 404; a record without a time is refused", async () => {
    const theirs = await other.call('POST', '/api/appointments', {
      title: 'Not yours',
      startsAt: hoursAhead(5),
      endsAt: hoursAhead(6),
    });
    const res = await inBusiness(owner)('POST', '/api/calendar/invites', {
      entity: 'appointment',
      id: theirs.body.value.id,
      to: [{ email: guest }],
    });
    expect(res.status).toBe(404);
    expect(
      (
        await inBusiness(owner)(
          'GET',
          `/api/calendar/invites?entity=appointment&id=${theirs.body.value.id}`,
        )
      ).status,
    ).toBe(404);
    const cancelled = await createAppointment(owner, { title: 'Off' });
    await inBusiness(owner)('PATCH', `/api/appointments/${cancelled}`, { status: 'cancelled' });
    const refused = await inBusiness(owner)('POST', '/api/calendar/invites', {
      entity: 'appointment',
      id: cancelled,
      to: [{ email: guest }],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('no_time');
  });
});

describe('feeds', () => {
  let url = '';
  let feedId = '';

  it('makes a private feed: its URL once, the person’s records, as they see them', async () => {
    const res = await inBusiness(staff)('POST', '/api/calendar/feeds', { label: 'Phone' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    url = res.body.url;
    feedId = res.body.value.id;
    expect(url).toMatch(/\/api\/calendar\/feed\/cf[\w-]{43}\.ics$/);
    const list = await inBusiness(staff)('GET', '/api/calendar/feeds');
    expect(list.body).toEqual([expect.objectContaining({ id: feedId, label: 'Phone' })]);
    expect(JSON.stringify(list.body)).not.toContain(url.split('/').pop()?.replace('.ics', ''));
    const { rows } = await pool.query('select token_hash from app.calendar_feeds where id = $1', [
      feedId,
    ]);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);

    const feed = await fetch(url);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('text/calendar');
    const text = unfolded(await feed.text());
    expect(text).toContain('SUMMARY:Staff call');
    expect(text).not.toContain('Hidden from staff');
    // The owner's records (and another business's) are not in the staff member's feed.
    expect(text).not.toContain('SUMMARY:Planning');
    expect(text).not.toContain('SUMMARY:Theirs');
  });

  it('is gone once revoked; an unknown token is a 404', async () => {
    expect((await inBusiness(staff)('DELETE', `/api/calendar/feeds/${feedId}`)).status).toBe(200);
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${server.base}/api/calendar/feed/cf${'a'.repeat(43)}.ics`)).status).toBe(
      404,
    );
    // Someone else's feed id is a 404 too.
    const mine = await owner.call('POST', '/api/calendar/feeds', {});
    expect((await other.call('DELETE', `/api/calendar/feeds/${mine.body.value.id}`)).status).toBe(
      404,
    );
  });

  it('asked for twice with one idempotency-key, is one feed; its URL only the first time', async () => {
    const key = { 'idempotency-key': randomUUID(), 'x-tenant-id': tenantId };
    const label = `Retry ${key['idempotency-key']}`;
    const first = await staff.call('POST', '/api/calendar/feeds', { label }, key);
    const again = await staff.call('POST', '/api/calendar/feeds', { label }, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.value.id).toBe(first.body.value.id);
    expect(first.body.url).toMatch(/\.ics$/);
    expect(again.body.url).toBeUndefined();
    const { rows } = await pool.query(
      'select count(*) n from app.calendar_feeds where label = $1',
      [label],
    );
    expect(Number(rows[0].n)).toBe(1);
    // Another label under the same key is another request.
    expect((await staff.call('POST', '/api/calendar/feeds', { label: 'Other' }, key)).status).toBe(
      409,
    );
  });
});

describe('calls', () => {
  let appt = '';
  let callId = '';

  it('logs a call on a record, read by whoever reads the record', async () => {
    appt = await createAppointment(owner, { title: 'Call me' });
    const res = await inBusiness(owner)('POST', '/api/calls', {
      direction: 'outbound',
      status: 'completed',
      to: '+14155550123',
      entity: 'appointment',
      id: appt,
      durationS: 90,
      notes: 'Agreed on Tuesday',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    callId = res.body.value.id;
    expect(res.body.value).toMatchObject({
      about: { entity: 'appointment', id: appt },
      createdBy: 'person',
      userId: owner.id,
    });
    const list = await inBusiness(owner)('GET', `/api/calls?entity=appointment&id=${appt}`);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([callId]);
    // Staff cannot read the owner's appointment, so neither its calls.
    expect(
      (await inBusiness(staff)('GET', `/api/calls?entity=appointment&id=${appt}`)).status,
    ).toBe(404);
    expect((await inBusiness(staff)('GET', `/api/calls/${callId}`)).status).toBe(404);
    expect((await other.call('GET', `/api/calls/${callId}`)).status).toBe(404);
    expect((await inBusiness(admin)('GET', `/api/calls/${callId}`)).status).toBe(200);
  });

  it('a call time Postgres cannot store is 400, logged or changed (V10)', async () => {
    // `z.iso.datetime({ offset: true })` took a time past 9999 in UTC: a bare 500.
    const far = '9999-12-31T23:59:59-01:00';
    for (const field of ['startedAt', 'endedAt']) {
      const res = await inBusiness(owner)('POST', '/api/calls', {
        direction: 'inbound',
        notes: `Too far ${field}`,
        [field]: far,
      });
      expect(res.status, `${field}: ${JSON.stringify(res.body)}`).toBe(400);
    }
    const changed = await inBusiness(owner)('PATCH', `/api/calls/${callId}`, { endedAt: far });
    expect(changed.status, JSON.stringify(changed.body)).toBe(400);
    const edge = await inBusiness(owner)('PATCH', `/api/calls/${callId}`, {
      endedAt: '9999-12-31T23:59:59Z',
    });
    expect(edge.status, JSON.stringify(edge.body)).toBe(200);
  });

  it('only whoever logged a call changes it', async () => {
    const mine = await inBusiness(owner)('PATCH', `/api/calls/${callId}`, {
      notes: 'Tuesday 10:00',
    });
    expect(mine.status).toBe(200);
    expect(mine.body.value.notes).toBe('Tuesday 10:00');
    const theirs = await inBusiness(admin)('PATCH', `/api/calls/${callId}`, { notes: 'x' });
    expect(theirs.status).toBe(403);
    expect(theirs.body.rule).toBe('not_your_call');
  });

  it('dialling needs a provider the business connected', async () => {
    expect((await inBusiness(owner)('GET', '/api/calls/provider')).body).toEqual({
      available: false,
      name: null,
    });
    const res = await inBusiness(owner)('POST', '/api/calls/dial', { to: '+14155550124' });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('no_telephony_provider');
  });

  it("dials through the business's provider, which reports back as the system", async () => {
    const conn = await inBusiness(owner)('POST', '/api/integrations/connections', {
      connector: 'fixture-phone',
    });
    expect(conn.status, JSON.stringify(conn.body)).toBe(201);
    const secret = conn.body.credentials.secret as string;
    // This business can call now; another business, without a connection, still cannot.
    expect((await inBusiness(staff)('GET', '/api/calls/provider')).body).toEqual({
      available: true,
      name: 'fixture-phone',
    });
    expect((await other.call('GET', '/api/calls/provider')).body.available).toBe(false);
    const res = await inBusiness(owner)('POST', '/api/calls/dial', {
      to: '+14155550124',
      entity: 'appointment',
      id: appt,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body.value.id;
    expect(res.body.value.status).toBe('requested');
    const ringing = await eventually(async () => {
      const c = await inBusiness(owner)('GET', `/api/calls/${id}`);
      return c.body.status === 'ringing' && c.body.provider ? c.body : undefined;
    });
    expect(ringing.provider).toBe('fixture-phone');
    const asked = await eventually(() => dialled.find((d) => d.request.callId === id));
    expect(asked.request).toMatchObject({
      to: '+14155550124',
      record: { entity: 'appointment', id: appt },
    });
    expect(asked.credentials).toEqual({ secret });
    // Each step of the dial is a write as the system: audited on the call, with call.updated.
    const steps = await eventually(async () => {
      const { rows } = await pool.query(
        `select actor_kind, channel, after from audit.events
          where action = 'call.update' and resource_id = $1 order by at, id`,
        [id],
      );
      return rows.length === 2 ? rows : undefined;
    });
    expect(steps.map((r) => [r.actor_kind, r.channel, r.after.status])).toEqual([
      ['system', 'background', 'ringing'],
      ['system', 'background', 'ringing'],
    ]);
    // Taken (no start yet), then placed: started now.
    expect([steps[0].after.startedAt, typeof steps[1].after.startedAt]).toEqual([null, 'string']);
    const { rows: outcomes } = await pool.query(
      "select count(*)::int as n from audit.events where action = 'call.dial_outcome' and resource_id = $1",
      [id],
    );
    expect(outcomes[0].n).toBe(2);
    const { rows: stored } = await pool.query(
      "select count(*)::int as n from app.domain_events where name = 'call.updated' and row->>'id' = $1",
      [id],
    );
    expect(stored[0].n).toBe(2);

    const body = JSON.stringify({
      type: 'call.status',
      externalId: `ext-${id}`,
      status: 'completed',
      durationS: 42,
    });
    const update = await fetch(`${server.base}/webhooks/fixture-phone/${conn.body.value.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-phone-event': `evt-${id}`,
        'x-fixture-phone-signature': createHmac('sha256', secret).update(body).digest('hex'),
      },
      body,
    });
    expect(update.status).toBe(200);
    const done = await eventually(async () => {
      const c = await inBusiness(owner)('GET', `/api/calls/${id}`);
      return c.body.status === 'completed' ? c.body : undefined;
    });
    expect(done.durationS).toBe(42);
    const audit = await pool.query(
      "select actor_kind, channel from audit.events where action = 'call.provider_update' and resource_id = $1",
      [id],
    );
    expect(audit.rows[0]).toEqual({ actor_kind: 'system', channel: 'background' });
  });

  it('a refused dial ends failed; the assistant’s dial waits for approval', async () => {
    const res = await inBusiness(owner)('POST', '/api/calls/dial', { to: REFUSED_NUMBER });
    const id = res.body.value.id;
    const failed = await eventually(async () => {
      const c = await inBusiness(owner)('GET', `/api/calls/${id}`);
      return c.body.status === 'failed' ? c.body : undefined;
    });
    expect(failed.error).toContain('refused');
    const why = await eventually(async () => {
      const { rows } = await pool.query(
        "select actor_kind, after from audit.events where action = 'call.update' and resource_id = $1 and after->>'status' = 'failed'",
        [id],
      );
      return rows[0];
    });
    expect(why.actor_kind).toBe('system');
    expect(why.after.error).toContain('refused');
    const assistant = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await assistant('POST', '/api/calls/dial', { to: '+14155550125' });
    expect(parked.body.status).toBe('needs_approval');
  });
});

describe('the assistant', () => {
  it('finds free time, invites (waiting for approval) and logs calls', async () => {
    await setTenantSettings(tenantId, { timeZone: 'UTC' });
    const free = await owner.chat('when am I free tomorrow for 60 minutes');
    expect(free.status).toBe(200);
    expect(free.body.reply).toMatch(/^You're free tomorrow at \d\d:\d\d/);
    const appt = await createAppointment(owner, { title: 'Asked by chat' });
    const invited = await owner.chat(
      `invite chat-${Date.now()}@example.test to appointment ${appt}`,
    );
    expect(invited.body.reply).toMatch(/^I've asked for your approval/);
    const logged = await owner.chat(`log a call on appointment ${appt}: left a message`);
    expect(logged.body.reply).toBe('Logged the call.');
    const calls = await owner.call('GET', `/api/calls?entity=appointment&id=${appt}`);
    expect(calls.body.items[0]).toMatchObject({ notes: 'left a message', createdBy: 'assistant' });
    expect((await other.chat('when am I free today')).body.reply).toMatch(/^You/);
  });
});

describe('disconnecting', () => {
  it('takes our events out of Google, closes the channel and revokes the grant', async () => {
    const [mine] = (await owner.call('GET', '/api/calendar/connections')).body;
    const ours = events(owner.email).filter((e) => e.status === 'confirmed');
    expect(ours.length).toBeGreaterThan(0);
    const res = await owner.call('DELETE', `/api/calendar/connections/${mine.id}`);
    expect(res.status).toBe(200);
    expect(events(owner.email).filter((e) => e.status === 'confirmed')).toEqual([]);
    expect(google.channels(owner.email)).toEqual([]);
    expect(google.revoked().length).toBeGreaterThan(0);
    expect((await owner.call('GET', '/api/calendar/connections')).body).toEqual([]);
    const { rows } = await pool.query(
      "select count(*)::int as n from app.integration_connections where tenant_id = $1 and connector = 'google-calendar' and public->>'userId' = $2",
      [tenantId, owner.id],
    );
    expect(rows[0].n).toBe(0);
    // New records no longer reach it.
    const later = await createAppointment(owner, { title: 'After' });
    await new Promise((r) => setTimeout(r, 2000));
    expect(eventFor(owner.email, later)).toBeUndefined();
  });
});
