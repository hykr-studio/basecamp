// SLAs (B6): a record entering a state starts that state's clocks in the write's transaction
// (business hours and durations from the business's settings), leaving it ends them, and the
// sweeper breaches the ones that run out, stores the breach event and runs the escalation's
// transition as the system principal. The fixture's tickets (fixture/src/features/states).
import { addBusinessTime, openHoursOf, type SlaTimer } from '@hykr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SlaService } from '../../dist/features/sla/sla.service.js';
import { addMember, boot, me, Person, pool, server, shutdown } from '../../dist/testing.js';
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

  it('a breach with roles carries them on its event, for the notification', async () => {
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
    expect(respondEvent.row.sla.escalate).toEqual({ roles: ['owner'] });
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
    const theirs = await stranger.call('GET', '/api/sla?status=running');
    expect(theirs.body).toEqual([]);
  });

  it('lists only the clocks of records the caller reads', async () => {
    const mine = await create(staff, 'Staff timed', inTenant());
    const owners = await create(owner, 'Owner timed');
    const list = (
      await staff.call('GET', '/api/sla?status=running&limit=100', undefined, inTenant())
    ).body as SlaTimer[];
    const ids = new Set(list.map((x) => x.resourceId));
    expect(ids.has(mine.id)).toBe(true);
    expect(ids.has(owners.id)).toBe(false);
    expect(
      (await staff.call('GET', `/api/sla/tickets/${owners.id}`, undefined, inTenant())).status,
    ).toBe(404);
    const all = (await owner.call('GET', '/api/sla?status=breached&limit=100')).body as SlaTimer[];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((x) => x.status === 'breached')).toBe(true);
  });
});
