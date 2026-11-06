// State machines (B6): a record starts in its initial state, only a declared transition moves
// it, each transition's checks (from, who, required fields, guard) refuse in plain words, an
// assistant's transition parks at its level and is audited, and each move stores an event with
// the row before and after. The fixture's tickets (fixture/src/features/states).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asAssistant, boot, me, Person, pool, shutdown } from '../../dist/testing.js';
import { statesServer } from '../fixture/dist/features/states/index.js';

const owner = new Person('Owner States');
const staff = new Person('Staff States');
const viewer = new Person('Viewer States');
const stranger = new Person('Stranger States');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

type Ticket = { id: string; title: string; status: string; note?: string | null; version: number };

const create = async (person: Person, title: string, extra: object = {}, headers = {}) => {
  const res = await person.call('POST', '/api/tickets', { title, ...extra }, headers);
  if (res.status !== 201 && res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.value as Ticket;
};
const move = (
  person: Person,
  id: string,
  name: string,
  body: object = {},
  headers: Record<string, string> = {},
) => person.call('POST', `/api/transitions/tickets/${id}/${name}`, body, headers);

const audit = async (resourceId: string, action: string) =>
  (
    await pool.query(
      'select actor_kind, outcome, rule, before, after from audit.events where resource_id = $1 and action = $2 order by at',
      [resourceId, action],
    )
  ).rows;

const events = async (resourceId: string, name: string) =>
  (
    await pool.query(
      'select name, row, before, actor_kind from app.domain_events where resource_id = $1 and name = $2 order by occurred_at',
      [resourceId, name],
    )
  ).rows;

beforeAll(async () => {
  await boot(statesServer);
  for (const p of [owner, staff, viewer, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(viewer, tenantId, ['fixture_viewer']);
});
afterAll(shutdown);

describe('a record moves only by its transitions', () => {
  let ticket: Ticket;

  it('starts in the initial state, and refuses another one on create', async () => {
    ticket = await create(owner, 'Leaky tap', { note: 'Back door' });
    expect(ticket).toMatchObject({ status: 'open', version: 1 });
    const other = await owner.call('POST', '/api/tickets', { title: 'Skip', status: 'active' });
    expect(other.status).toBe(403);
    expect(other.body.rule).toBe('state_initial');
  });

  it('plain CRUD never moves the state, and says which transitions do', async () => {
    const res = await owner.call('PATCH', `/api/tickets/${ticket.id}`, { status: 'resolved' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'state_through_transition' });
    expect(res.body.reason).toContain('start');
    const [refused] = await audit(ticket.id, 'ticket.update');
    expect(refused).toMatchObject({ outcome: 'denied', rule: 'state_through_transition' });
  });

  it('a transition moves it, audited with the row before and after', async () => {
    const res = await move(owner, ticket.id, 'start');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', value: { status: 'active', version: 2 } });
    const [op] = await audit(ticket.id, 'ticket.transition');
    expect(op).toMatchObject({ actor_kind: 'user', outcome: 'committed' });
    const row = (await audit(ticket.id, 'ticket.update')).find((r) => r.outcome === 'committed');
    expect(row.before.status).toBe('open');
    expect(row.after.status).toBe('active');
  });

  it('stores an event per transition with the row before and after', async () => {
    const [e] = await events(ticket.id, 'ticket.start');
    expect(e.row.status).toBe('active');
    expect(e.before.status).toBe('open');
  });

  it('refuses a transition from the wrong state, and an unknown one', async () => {
    const again = await move(owner, ticket.id, 'start');
    expect(again.status).toBe(403);
    expect(again.body).toMatchObject({ rule: 'not_from_state' });
    expect((await move(owner, ticket.id, 'teleport')).status).toBe(404);
  });

  it('refuses a transition without the fields it requires, and runs it with them', async () => {
    const bare = await move(owner, ticket.id, 'resolve');
    expect(bare.body).toMatchObject({ rule: 'transition_requires' });
    const blank = await move(owner, ticket.id, 'resolve', { resolution: '  ' });
    expect(blank.body).toMatchObject({ rule: 'transition_requires' });
    const done = await move(owner, ticket.id, 'resolve', { resolution: 'New washer' });
    expect(done.body.value).toMatchObject({ status: 'resolved', resolution: 'New washer' });
    // Only the transition's own fields go with it; another field of the record is refused.
    const extra = await move(owner, ticket.id, 'reopen', { title: 'Renamed' });
    expect(extra.status).toBe(400);
  });

  it("refuses what the transition's guard refuses", async () => {
    const held = await create(owner, '[hold] Roof');
    const res = await move(owner, held.id, 'resolve', { resolution: 'Done' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'ticket_on_hold', reason: 'This ticket is on hold' });
  });

  it('refuses a capability the person lacks, a system-only move and a people-only one', async () => {
    const mine = await create(staff, 'Staff ticket', {}, inTenant());
    await move(staff, mine.id, 'resolve', { resolution: 'Fixed' }, inTenant());
    const close = await move(staff, mine.id, 'close', {}, inTenant());
    expect(close.status).toBe(403);
    expect(close.body.rule).toBe('transition_not_allowed');
    const escalate = await move(owner, (await create(owner, 'Esc')).id, 'escalate');
    expect(escalate.body.rule).toBe('system_only');
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const reopen = await asks('POST', `/api/transitions/tickets/${ticket.id}/reopen`, {});
    expect(reopen.status).toBe(403);
    expect(reopen.body.rule).toBe('humans_only');
    // The owner holds the capability.
    const closed = await move(owner, ticket.id, 'close');
    expect(closed.body.value.status).toBe('closed');
  });
});

describe("the assistant's transitions wait at their level", () => {
  it('parks a cancel at level 2 for the person, audits it, and runs it on approval', async () => {
    const t = await create(owner, 'Old request');
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', `/api/transitions/tickets/${t.id}/cancel`, {});
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval).toMatchObject({
      tier: 2,
      action: 'ticket.transition',
      input: { transition: 'cancel' },
    });
    expect(parked.body.approval.summary).toBe('Cancel ticket "Old request" (v1, version 1): open → cancelled');
    const [asked] = await audit(t.id, 'ticket.transition');
    expect(asked).toMatchObject({ actor_kind: 'agent', outcome: 'needs_approval' });
    expect((await owner.call('GET', `/api/tickets/${t.id}`)).body.status).toBe('open');
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
    expect((await owner.call('GET', `/api/tickets/${t.id}`)).body.status).toBe('cancelled');
    // Its own event name.
    const [e] = await events(t.id, 'ticket.dropped');
    expect(e.before.status).toBe('open');
    expect(e.row.status).toBe('cancelled');
  });

  it('parks a close at level 3 for an owner', async () => {
    const t = await create(owner, 'To close');
    await move(owner, t.id, 'resolve', { resolution: 'Yes' });
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', `/api/transitions/tickets/${t.id}/close`, {});
    expect(parked.body.approval).toMatchObject({ tier: 3 });
    const { rows } = await pool.query('select approver_roles from app.approvals where id = $1', [
      parked.body.approval.id,
    ]);
    expect(rows[0].approver_roles).toEqual(['owner']);
  });

  it('a transition approved after the record moved on fails with the reason', async () => {
    const t = await create(owner, 'Moving target');
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', `/api/transitions/tickets/${t.id}/cancel`, {});
    await owner.call('PATCH', `/api/tickets/${t.id}`, { title: 'Moved on' });
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('failed');
    expect(approved.body.failureReason).toContain('changed since it was asked for');
    expect((await owner.call('GET', `/api/tickets/${t.id}`)).body.status).toBe('open');
  });

  it('through chat: the transition tool finds the record and moves it', async () => {
    const t = await create(owner, 'Tool ticket');
    const res = await owner.chat('apply start to tickets "Tool ticket"');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('took');
    const now = (await owner.call('GET', `/api/tickets/${t.id}`)).body;
    expect(now.status).toBe('active');
    const [op] = await audit(t.id, 'ticket.transition');
    expect(op.actor_kind).toBe('agent');
  });
});

describe('who reaches a transition', () => {
  it('another business gets 404, for the move and the record', async () => {
    const t = await create(owner, 'Private');
    const res = await move(stranger, t.id, 'start');
    expect(res.status).toBe(404);
    expect((await owner.call('GET', `/api/tickets/${t.id}`)).body.status).toBe('open');
  });

  it('a reader who may not write gets 404, not a request someone else approves', async () => {
    const t = await create(owner, 'Read only');
    expect((await viewer.call('GET', `/api/tickets/${t.id}`, undefined, inTenant())).status).toBe(
      200,
    );
    const res = await move(viewer, t.id, 'start', {}, inTenant());
    expect(res.status).toBe(404);
    const asks = asAssistant(`user:${viewer.id}`, { 'x-channel': 'app', ...inTenant() });
    const parked = await asks('POST', `/api/transitions/tickets/${t.id}/cancel`, {});
    expect(parked.status).toBe(404);
  });

  it('a hidden field stays hidden in the result and on the approval card', async () => {
    const t = await create(owner, 'Noted', { note: 'Owner only' });
    // Staff reach their own tickets only; this one is the owner's.
    const theirs = await create(staff, 'Staff noted', {}, inTenant());
    const moved = await move(staff, theirs.id, 'start', {}, inTenant());
    expect(moved.body.value).not.toHaveProperty('note');
    expect((await move(staff, t.id, 'start', {}, inTenant())).status).toBe(404);
    const asks = asAssistant(`user:${staff.id}`, { 'x-channel': 'app', ...inTenant() });
    const parked = await asks('POST', `/api/transitions/tickets/${theirs.id}/cancel`, {});
    expect(parked.body.status).toBe('needs_approval');
    const card = await staff.call(
      'GET',
      `/api/approvals/${parked.body.approval.id}`,
      undefined,
      inTenant(),
    );
    expect(card.body.input).toEqual({ transition: 'cancel' });
    const own = await owner.call('GET', `/api/tickets/${t.id}`);
    expect(own.body.note).toBe('Owner only');
  });

  it("the history shows a state change's from and to", async () => {
    const t = await create(owner, 'Historic');
    await move(owner, t.id, 'start');
    const history = await owner.call(
      'GET',
      `/api/history?resourceType=ticket&resourceId=${t.id}`,
    );
    const moves = history.body
      .map((e: { transition?: unknown }) => e.transition)
      .filter((x: unknown) => x);
    // The create entered the initial state; the transition moved it on.
    expect(moves).toContainEqual({ from: null, to: 'open' });
    expect(moves).toContainEqual({ from: 'open', to: 'active' });
  });
});
