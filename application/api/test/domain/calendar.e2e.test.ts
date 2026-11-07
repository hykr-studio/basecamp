// The meetings module on calendars (B17): a meeting reaches its owner's connected Google
// calendar (the in-memory fake), and moving it there moves the meeting here, as its owner,
// with its open to-dos. Invites go out by email with an .ics.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.GOOGLE_CALENDAR_TRANSPORT = 'fake';

import { boot, eventually, fakeGoogle, Person, pool, server, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const google = fakeGoogle();
const ana = new Person('Ana Calendar');

const HOUR = 3_600_000;
const hoursAhead = (h: number) => {
  const d = new Date(Date.now() + h * HOUR);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};
const day = (iso: string) => iso.slice(0, 10);
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const ours = (recordId: string) =>
  google
    .events(ana.email)
    .find((e) => e.extendedProperties?.private?.record === recordId && e.status !== 'cancelled');

beforeAll(async () => {
  await boot(application);
  process.env.CALENDAR_PUBLIC_URL = server.base;
  process.env.GOOGLE_CALENDAR_REDIRECT_URL = `${server.base}/api/calendar/google/callback`;
  await ana.signUp();
  const res = await ana.call('POST', '/api/calendar/connections', { provider: 'google' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect((await fetch(res.body.url, { redirect: 'manual' })).status).toBe(302);
  await eventually(() => google.channels(ana.email).length === 1);
});
afterAll(shutdown);

describe('meetings in calendars', () => {
  let meetingId = '';
  let todoId = '';

  it("a meeting reaches its owner's calendar, with its place", async () => {
    const res = await ana.call('POST', '/api/meetings', {
      title: 'Calendar review',
      startsAt: hoursAhead(26),
      endsAt: hoursAhead(27),
      address: { line1: '1 Lake Road', locality: 'Springfield', country: 'IN' },
    });
    expect(res.status).toBe(201);
    meetingId = res.body.value.id;
    const todo = await ana.call('POST', '/api/todos', {
      title: 'Prepare the agenda',
      meetingId,
      dueOn: day(hoursAhead(26)),
    });
    todoId = todo.body.value.id;
    const e = await eventually(() => ours(meetingId));
    expect(e).toMatchObject({
      summary: 'Calendar review',
      location: '1 Lake Road, Springfield, IN',
    });
  });

  it('moving it in Google moves the meeting and its open to-dos, as its owner', async () => {
    // Where changes are read from is set once the connection is filled.
    await eventually(async () => {
      const { rows } = await pool.query(
        'select sync_token from app.calendar_connections where user_id = $1',
        [ana.id],
      );
      return rows[0]?.sync_token;
    });
    const e = ours(meetingId);
    const start = hoursAhead(26 + 48);
    google.edit(ana.email, e?.id as string, {
      start: { dateTime: start },
      end: { dateTime: hoursAhead(27 + 48) },
    });
    expect(await google.push(ana.email)).toEqual([200]);
    const moved = await eventually(async () => {
      const m = await ana.call('GET', `/api/meetings/${meetingId}`);
      return m.body.startsAt === start ? m.body : undefined;
    });
    expect(moved.endsAt).toBe(hoursAhead(27 + 48));
    const todo = await ana.call('GET', `/api/todos/${todoId}`);
    expect(todo.body.dueOn).toBe(addDays(day(hoursAhead(26)), 2));
    const audit = await pool.query(
      "select actor_kind, actor_id, channel from audit.events where action = 'meeting.reschedule' and resource_id = $1",
      [meetingId],
    );
    expect(audit.rows[0]).toEqual({ actor_kind: 'user', actor_id: ana.id, channel: 'background' });
  });

  it('the assistant invites someone to a meeting, waiting for approval', async () => {
    const res = await ana.chat('invite guest@example.com to Calendar review');
    expect(res.body.reply).toMatch(/^I've asked for your approval/);
  });
});
