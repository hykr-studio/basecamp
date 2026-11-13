// SLAs (B6): a record entering a state starts that state's clocks in the write's transaction
// (business hours and durations from the business's settings), leaving it ends them, and the
// sweeper breaches the ones that run out, stores the breach event and runs the escalation's
// transition as the system principal. The fixture's tickets (fixture/src/features/states).
import { addBusinessTime, openHoursOf, type SlaPage, type SlaTimer } from '@hykr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SlaService } from '../../dist/features/sla/sla.service.js';
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
import { statesServer } from '../fixture/dist/features/states/index.js';

const owner = new Person('Owner Sla');
const staff = new Person('Staff Sla');
const stranger = new Person('Stranger Sla');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const HOURS = {
  week: Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [{ from: '09:00', to: '17:00' }]]),
  ),
  holidays: ['2026-12-25'],
};

type Ticket = { id: string; title: string; status: string };
const create = async (person: Person, title: string, headers = {}) =>
  (await person.call('POST', '/api/tickets', { title }, headers)).body.value as Ticket;
const timers = async (person: Person, id: string, headers = {}) =>
  (await person.call('GET', `/api/sla/tickets/${id}`, undefined, headers)).body as SlaTimer[];
const timer = async (id: string, sla: string) =>
  (await timers(owner, id)).find((t) => t.sla === sla) as SlaTimer;
/** One page of GET /api/sla. */
const page = async (person: Person, query: string, headers = {}) => {
  const res = await person.call('GET', `/api/sla?${query}`, undefined, headers);
  expect(res.status).toBe(200);
  return res.body as SlaPage;
};
/** Every page of GET /api/sla, walked by its cursors. */
const allPages = async (person: Person, query: string, headers = {}) => {
  const items: SlaTimer[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 100; n++) {
    const next: SlaPage = await page(
      person,
      `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      headers,
    );
    items.push(...next.items);
    cursor = next.nextCursor;
    if (!cursor) return items;
  }
  throw new Error('More than 100 pages');
};
const sweeper = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(SlaService, { strict: false });
};
const at = (iso: string, plusMs: number) => new Date(new Date(iso).getTime() + plusMs);

beforeAll(async () => {
  await boot(statesServer);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  // Open Monday to Friday, 9 to 5, in UTC; the escalation's 48 hours are 1 hour here, and the
  // work clock is off.
  await pool.query(`update app.tenants set settings = settings || $2::jsonb where id = $1`, [
    tenantId,
    JSON.stringify({
      timeZone: 'UTC',
      businessHours: HOURS,
      sla: { within: { 'fixture.tickets.escalate': '1h' }, off: ['fixture.tickets.work'] },
    }),
  ]);
});
afterAll(shutdown);

describe('clocks start and stop with the state', () => {
  it("entering a state starts its SLAs, counted in the business's hours and durations", async () => {
    const t = await create(owner, 'Timed');
    const list = await timers(owner, t.id);
    expect(list.map((x) => x.sla).sort()).toEqual([
      'fixture.tickets.escalate',
      'fixture.tickets.respond',
    ]);
    const respond = list.find((x) => x.sla === 'fixture.tickets.respond') as SlaTimer;
    expect(respond).toMatchObject({ state: 'open', status: 'running', hours: 'business' });
    const expected = addBusinessTime(
      new Date(respond.startedAt),
      2 * 3_600_000,
      openHoursOf({ ...HOURS, holidays: HOURS.holidays }),
      'UTC',
    );
    expect(respond.dueAt).toBe(expected.toISOString());
    const escalate = list.find((x) => x.sla === 'fixture.tickets.escalate') as SlaTimer;
    expect(new Date(escalate.dueAt).getTime() - new Date(escalate.startedAt).getTime()).toBe(
      3_600_000,
    );
  });

  it('leaving the state ends them as met; a clock the business switched off never starts', async () => {
    const t = await create(owner, 'Started');
    await owner.call('POST', `/api/transitions/tickets/${t.id}/start`, {});
    const list = await timers(owner, t.id);
    expect(list).toHaveLength(2);
    for (const x of list) expect(x).toMatchObject({ status: 'met', breachedAt: null });
    expect(list.every((x) => x.endedAt)).toBe(true);
  });

  it('leaving a state after the time ran out records the breach, without escalating', async () => {
    const t = await create(owner, 'Late');
    await pool.query(
      "update app.sla_timers set due_at = now() - interval '1 minute' where resource_id = $1",
      [t.id],
    );
    await owner.call('POST', `/api/transitions/tickets/${t.id}/start`, {});
    for (const x of await timers(owner, t.id)) expect(x.status).toBe('breached');
    const { rows } = await pool.query(
      "select 1 from app.domain_events where resource_id = $1 and name = 'ticket.sla.breached'",
      [t.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('deleting the record cancels its clocks', async () => {
    const t = await create(owner, 'Gone');
    expect((await owner.call('DELETE', `/api/tickets/${t.id}`)).status).toBeLessThan(300);
    const { rows } = await pool.query('select status from app.sla_timers where resource_id = $1', [
      t.id,
    ]);
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('the sweeper', () => {
  it('breaches a clock that ran out, stores the event and escalates as the system', async () => {
    const t = await create(owner, 'Waiting');
    const escalate = await timer(t.id, 'fixture.tickets.escalate');
    const done = await sweeper().sweep(at(escalate.dueAt, 60_000));
    expect(done.breached).toBeGreaterThanOrEqual(1);
    const after = await timer(t.id, 'fixture.tickets.escalate');
    expect(after).toMatchObject({ status: 'breached', escalationError: null });
    expect((await owner.call('GET', `/api/tickets/${t.id}`)).body.status).toBe('escalated');
    const { rows: audit } = await pool.query(
      "select actor_kind, actor_id, channel, outcome from audit.events where resource_id = $1 and action = 'ticket.transition'",
      [t.id],
    );
    expect(audit).toEqual([
      {
        actor_kind: 'system',
        actor_id: 'sla.escalate',
        channel: 'background',
        outcome: 'committed',
      },
    ]);
    const { rows: events } = await pool.query(
      'select name, row from app.domain_events where resource_id = $1 order by occurred_at',
      [t.id],
    );
    const breach = events.find((e) => e.name === 'ticket.sla.breached');
    expect(breach.row.sla).toMatchObject({
      name: 'fixture.tickets.escalate',
      state: 'open',
      escalate: { transition: 'escalate' },
    });
    expect(events.map((e) => e.name)).toContain('ticket.escalate');
    // Leaving open ended the other clock.
    expect((await timer(t.id, 'fixture.tickets.respond')).endedAt).not.toBeNull();
  });

  it('a breach carries who should hear about it on its event, for the notification', async () => {
    const t = await create(owner, 'Unanswered');
    const respond = await timer(t.id, 'fixture.tickets.respond');
    // Its escalation's clock (1 hour) would run out first and move it on: later, for this one.
    await pool.query(
      "update app.sla_timers set due_at = due_at + interval '60 days' where resource_id = $1 and sla = 'fixture.tickets.escalate'",
      [t.id],
    );
    await sweeper().sweep(at(respond.dueAt, 60_000));
    const { rows } = await pool.query(
      "select row from app.domain_events where resource_id = $1 and name = 'ticket.sla.breached'",
      [t.id],
    );
    const names = rows.map((r) => r.row.sla.name).sort();
    expect(names).toContain('fixture.tickets.respond');
    const respondEvent = rows.find((r) => r.row.sla.name === 'fixture.tickets.respond');
    expect(respondEvent.row.sla.escalate).toEqual({ notify: ['fixture.tickets.close'] });
    expect(respondEvent.row.title).toBe('Unanswered');
  });

  it('a refused escalation is kept on the timer; the breach stands', async () => {
    const t = await create(owner, '[hold] Parked');
    const escalate = await timer(t.id, 'fixture.tickets.escalate');
    const done = await sweeper().sweep(at(escalate.dueAt, 60_000));
    expect(done.failed).toBeGreaterThanOrEqual(1);
    const after = await timer(t.id, 'fixture.tickets.escalate');
    expect(after).toMatchObject({ status: 'breached', escalationError: 'This ticket is on hold' });
    expect((await owner.call('GET', `/api/tickets/${t.id}`)).body.status).toBe('open');
    const { rows } = await pool.query(
      "select actor_kind, outcome, rule from audit.events where resource_id = $1 and action = 'ticket.transition'",
      [t.id],
    );
    expect(rows).toEqual([{ actor_kind: 'system', outcome: 'denied', rule: 'ticket_on_hold' }]);
  });

  it("never takes another queue prefix's clocks", async () => {
    const t = await create(owner, 'Elsewhere');
    await pool.query("update app.sla_timers set queues = 'someone-else' where resource_id = $1", [
      t.id,
    ]);
    await sweeper().sweep(at(new Date().toISOString(), 30 * 24 * 3_600_000));
    for (const x of await timers(owner, t.id)) expect(x.status).toBe('running');
    await pool.query('delete from app.sla_timers where resource_id = $1', [t.id]);
  });
});

describe('who sees the clocks', () => {
  it("another business gets 404 for a record's clocks, and none in its lists", async () => {
    const t = await create(owner, 'Ours');
    expect((await stranger.call('GET', `/api/sla/tickets/${t.id}`)).status).toBe(404);
    expect(await page(stranger, 'status=running')).toEqual({ items: [], nextCursor: null });
    expect(await page(stranger, 'status=running&resourceType=ticket')).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('lists only the clocks of records the caller reads', async () => {
    const mine = await create(staff, 'Staff timed', inTenant());
    const owners = await create(owner, 'Owner timed');
    const list = await allPages(staff, 'status=running&limit=100', inTenant());
    const ids = new Set(list.map((x) => x.resourceId));
    expect(ids.has(mine.id)).toBe(true);
    expect(ids.has(owners.id)).toBe(false);
    expect(
      (await staff.call('GET', `/api/sla/tickets/${owners.id}`, undefined, inTenant())).status,
    ).toBe(404);
    const all = (await page(owner, 'status=breached&limit=100')).items;
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((x) => x.status === 'breached')).toBe(true);
    // A type that names no entity with states lists nothing.
    expect(await page(owner, 'status=breached&resourceType=nothing')).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('a breach still late is listed however many ended ones were due before it', async () => {
    // Three records that moved on after their time ran out: six ended breaches, due long ago.
    for (const n of [1, 2, 3]) {
      const t = await create(owner, `Moved on late ${n}`);
      await pool.query(
        "update app.sla_timers set due_at = now() - interval '30 days' where resource_id = $1",
        [t.id],
      );
      await owner.call('POST', `/api/transitions/tickets/${t.id}/start`, {});
    }
    // One still waiting, due after them: its notify-only clock breaches and the record stays.
    const late = await create(owner, 'Still late');
    await pool.query(
      `update app.sla_timers set due_at = case when sla = 'fixture.tickets.respond'
         then now() - interval '20 days' else now() + interval '60 days' end
       where resource_id = $1`,
      [late.id],
    );
    await sweeper().sweep(new Date());
    // Without `open`, the earliest due are the ended ones: a client filtering them would see none.
    const both = (await page(owner, 'status=breached&limit=5')).items;
    expect(both).toHaveLength(5);
    expect(both.every((x) => x.endedAt)).toBe(true);
    const open = (await page(owner, 'status=breached&open=true&limit=5')).items;
    expect(open[0]).toMatchObject({
      resourceId: late.id,
      sla: 'fixture.tickets.respond',
      status: 'breached',
      endedAt: null,
    });
    expect(open.every((x) => x.status === 'breached' && x.endedAt === null)).toBe(true);
    const ended = await allPages(owner, 'status=breached&open=false&limit=100');
    expect(ended.length).toBeGreaterThanOrEqual(6);
    expect(ended.every((x) => x.endedAt !== null)).toBe(true);
    expect(ended.some((x) => x.resourceId === late.id)).toBe(false);
    // Another business sees none of them.
    expect((await page(stranger, 'status=breached&open=true')).items).toEqual([]);
  });

  it("others' earlier clocks never crowd out the caller's own, nor cost a read each", async () => {
    // 20,000 breaches on 2,000 records staff can't read, all due first. Reading one record per
    // timer and paging through them took 4.5 s per request at this size; reach decided in SQL
    // answers in milliseconds.
    const { rows: bulk } = await pool.query(
      `insert into app.fixture_tickets (tenant_id, owner_id, title, status)
       select $1, $2, 'Owner late often ' || n, 'open' from generate_series(1, 2000) n
       returning id`,
      [tenantId, owner.id],
    );
    const theirs = bulk.map((r) => r.id as string);
    await pool.query(
      `insert into app.sla_timers (tenant_id, resource_type, resource_id, sla, state, status,
         started_at, due_at, breached_at, queues)
       select $1, 'ticket', t.id, 'fixture.tickets.respond', 'open', 'breached',
         now() - interval '50 days',
         now() - interval '45 days' + (t.n * 10 + g) * interval '1 millisecond',
         now(), 'someone-else'
       from unnest($2::text[]) with ordinality t(id, n), generate_series(1, 10) g`,
      [tenantId, theirs],
    );
    try {
      const started = Date.now();
      const none = await page(staff, 'status=breached&open=true&limit=1', inTenant());
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(none).toEqual({ items: [], nextCursor: null });

      const mine = await create(staff, 'Staff late', inTenant());
      await pool.query(
        `update app.sla_timers set status = 'breached', breached_at = now(),
           due_at = now() - interval '44 days'
         where resource_id = $1 and sla = 'fixture.tickets.respond'`,
        [mine.id],
      );
      const list = await page(staff, 'status=breached&open=true&limit=1', inTenant());
      expect(list.items).toEqual([
        expect.objectContaining({ resourceId: mine.id, status: 'breached' }),
      ]);
      // The owner reads both: theirs come first, earliest due.
      const owners = await page(owner, 'status=breached&open=true&limit=3');
      expect(owners.items.map((x) => x.resourceId)).toEqual([theirs[0], theirs[0], theirs[0]]);
      expect(owners.nextCursor).toEqual(expect.any(String));
    } finally {
      await pool.query('delete from app.sla_timers where resource_id = any($1::text[])', [theirs]);
      await pool.query('delete from app.fixture_tickets where id = any($1::text[])', [theirs]);
    }
  });

  it('pages by due time then id, to the microsecond, each clock once', async () => {
    // Met clocks due long before any other, some at the same instant, some a microsecond apart
    // (one millisecond in JavaScript): the cursor keeps Postgres's exact time.
    const t = await create(owner, 'Paged');
    await pool.query(
      `insert into app.sla_timers (tenant_id, resource_type, resource_id, sla, state, status,
         started_at, due_at, ended_at, queues)
       select $1, 'ticket', $2, 'fixture.tickets.respond', 'open', 'met',
         timestamptz '2001-01-01 00:00:00+00',
         timestamptz '2001-01-02 00:00:00.000500+00' + (n / 3) * interval '1 microsecond',
         timestamptz '2001-01-02 00:00:00+00', 'someone-else'
       from generate_series(0, 6) n`,
      [tenantId, t.id],
    );
    try {
      const { rows } = await pool.query(
        "select id from app.sla_timers where resource_id = $1 and status = 'met' order by due_at, id",
        [t.id],
      );
      const expected = rows.map((r) => r.id as string);
      expect(expected).toHaveLength(7);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const next: SlaPage = await page(
          owner,
          `status=met&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(next.items.length).toBeLessThanOrEqual(2);
        seen.push(...next.items.map((x) => x.id));
        cursor = next.nextCursor;
      } while (cursor && seen.length < 7);
      expect(seen.slice(0, 7)).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      // The same as one larger page.
      const one = await page(owner, 'status=met&limit=7');
      expect(one.items.map((x) => x.id)).toEqual(expected);
    } finally {
      await pool.query("delete from app.sla_timers where resource_id = $1 and status = 'met'", [
        t.id,
      ]);
    }
  });

  it('a cursor that does not parse is a 400', async () => {
    for (const cursor of [
      'nope',
      Buffer.from('{"d":"x","i":"y"}').toString('base64url'),
      // An id Postgres's text cannot hold (V10): a 500 before.
      Buffer.from(JSON.stringify({ d: '2026-01-01T00:00:00.000000', i: 'a\u0000b' })).toString(
        'base64url',
      ),
    ]) {
      const res = await owner.call('GET', `/api/sla?status=breached&cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'bad_cursor' });
    }
  });
});

describe('clocks kept with their records', () => {
  it('the assistant sees no clock on records kept from it, and 404 for one', async () => {
    const kept = (
      await owner.call('POST', '/api/privateTickets', { title: 'Kept from the assistant' })
    ).body.value as { id: string };
    const open = await create(owner, 'The assistant may see');
    const assistant = asAssistant(`user:${owner.id}`, inTenant());

    const res = await assistant('GET', '/api/sla?status=running&limit=100');
    expect(res.status).toBe(200);
    const listed = res.body as SlaPage;
    expect(listed.items.some((x) => x.resourceType === 'privateTicket')).toBe(false);
    expect(listed.items.some((x) => x.resourceId === open.id)).toBe(true);
    expect(
      (await assistant('GET', '/api/sla?status=running&resourceType=privateTicket')).body,
    ).toEqual({ items: [], nextCursor: null });
    expect((await assistant('GET', `/api/sla/privateTickets/${kept.id}`)).status).toBe(404);
    expect((await assistant('GET', `/api/sla/tickets/${open.id}`)).status).toBe(200);

    // The owner sees them: in the list and on the record.
    const theirs = await allPages(owner, 'status=running&resourceType=privateTicket');
    expect(theirs.map((x) => x.resourceId)).toContain(kept.id);
    const clocks = (await owner.call('GET', `/api/sla/privateTickets/${kept.id}`))
      .body as SlaTimer[];
    expect(clocks.map((x) => x.sla)).toEqual(['fixture.private-tickets.respond']);
    // Another business: not there at all.
    expect((await stranger.call('GET', `/api/sla/privateTickets/${kept.id}`)).status).toBe(404);
  });

  it('a record whose state is hidden from the reader shows them none of its clocks', async () => {
    const sealed = await create(staff, '[sealed] Staff sealed', inTenant());
    const plain = await create(staff, 'Staff plain', inTenant());
    // Due before any of staff's other running clocks (and out of this sweeper's way).
    await pool.query(
      `update app.sla_timers set due_at = timestamptz '2001-01-03 00:00:00+00',
         queues = 'someone-else'
       where resource_id = $1`,
      [sealed.id],
    );
    try {
      // The page is cut first, then the sealed ticket's two clocks are dropped: an empty page
      // that still has a next one.
      const first = await page(staff, 'status=running&limit=2', inTenant());
      expect(first.items).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const staffs = await allPages(staff, 'status=running&limit=2', inTenant());
      const ids = new Set(staffs.map((x) => x.resourceId));
      expect(ids.has(plain.id)).toBe(true);
      expect(ids.has(sealed.id)).toBe(false);
      const one = await staff.call('GET', `/api/sla/tickets/${sealed.id}`, undefined, inTenant());
      expect(one.status).toBe(200);
      expect(one.body).toEqual([]);

      // The owner reads sealed tickets' status, and so their clocks.
      const owners = await page(owner, 'status=running&limit=2');
      expect(owners.items.map((x) => x.resourceId)).toEqual([sealed.id, sealed.id]);
      expect(await timers(owner, sealed.id)).toHaveLength(2);
    } finally {
      await pool.query('delete from app.sla_timers where resource_id = $1', [sealed.id]);
    }
  });
});
