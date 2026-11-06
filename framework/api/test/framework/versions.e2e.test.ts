// Versions and frozen records (B4): every write bumps a record's version and a write against an
// old one is 409; a parked write is pinned to the version it saw; a frozen record (and its
// children) refuses changes but its state still moves; a revision copies a record and its tree
// as v2 in one write; the versions list is scoped like the record. The fixture's tickets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asAssistant, boot, me, Person, pool, shutdown } from '../../dist/testing.js';
import { statesServer } from '../fixture/dist/features/states/index.js';

const owner = new Person('Owner Versions');
const staff = new Person('Staff Versions');
const stranger = new Person('Stranger Versions');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

type Ticket = {
  id: string;
  title: string;
  status: string;
  note?: string | null;
  version: number;
  revision: number;
  seriesId: string | null;
};
type Step = { id: string; title: string; parentStepId: string | null };

const create = async (person: Person, title: string, extra: object = {}, headers = {}) =>
  (await person.call('POST', '/api/tickets', { title, ...extra }, headers)).body.value as Ticket;
const get = async (id: string) => (await owner.call('GET', `/api/tickets/${id}`)).body as Ticket;
const resolve = (person: Person, id: string, headers = {}) =>
  person.call('POST', `/api/transitions/tickets/${id}/resolve`, { resolution: 'Done' }, headers);
const plan = (person: Person, id: string, headers = {}) =>
  person.call(
    'POST',
    `/api/tickets/${id}/plan`,
    {
      steps: [
        { ref: 'a', title: 'Look' },
        { ref: 'a1', parent: 'a', title: 'Measure' },
        { ref: 'b', title: 'Fix' },
      ],
    },
    headers,
  );
const steps = async (id: string) =>
  (await owner.call('GET', `/api/ticketSteps?ticketId=${id}`)).body.items as Step[];

beforeAll(async () => {
  await boot(statesServer);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
});
afterAll(shutdown);

describe('versions', () => {
  it('bumps the version on every write, and refuses a write against an old one (409)', async () => {
    const t = await create(owner, 'Counted');
    expect(t.version).toBe(1);
    const first = await owner.call('PATCH', `/api/tickets/${t.id}`, { title: 'Counted 2' });
    expect(first.body.value.version).toBe(2);
    const stale = await owner.call('PATCH', `/api/tickets/${t.id}`, {
      title: 'From an old screen',
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale');
    const fresh = await owner.call('PATCH', `/api/tickets/${t.id}`, { title: 'Now', version: 2 });
    expect(fresh.body.value).toMatchObject({ title: 'Now', version: 3 });
  });

  it("a parked edit names the version it saw, and fails if the record moved on", async () => {
    const t = await create(owner, 'Pinned');
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('PATCH', `/api/tickets/${t.id}`, { title: 'By the assistant' });
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval.summary).toContain('(v1, version 1)');
    await owner.call('PATCH', `/api/tickets/${t.id}`, { title: 'By the owner' });
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('failed');
    expect(approved.body.failureReason).toContain('version 1 then, 2 now');
    expect((await get(t.id)).title).toBe('By the owner');
  });

  it("a parked edit approved before anything changed runs", async () => {
    const t = await create(owner, 'Still');
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('PATCH', `/api/tickets/${t.id}`, { title: 'Changed' });
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
    expect(await get(t.id)).toMatchObject({ title: 'Changed', version: 2 });
  });

  it("a command pins what it loaded: a plan approved after an edit fails", async () => {
    const t = await create(owner, 'Planned');
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', `/api/tickets/${t.id}/plan`, { steps: [{ ref: 'x', title: 'X' }] });
    expect(parked.body.status).toBe('needs_approval');
    await owner.call('PATCH', `/api/tickets/${t.id}`, { title: 'Planned again' });
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('failed');
    expect(await steps(t.id)).toEqual([]);
  });
});

describe('frozen records', () => {
  let t: Ticket;

  it('a frozen record refuses changes and deletes, but keeps its editable fields', async () => {
    t = await create(owner, 'Frozen');
    expect((await plan(owner, t.id)).status).toBe(200);
    await resolve(owner, t.id);
    const edit = await owner.call('PATCH', `/api/tickets/${t.id}`, { title: 'Thawed' });
    expect(edit.status).toBe(403);
    expect(edit.body).toMatchObject({
      rule: 'record_frozen',
      reason: "This ticket is resolved: it can't be changed",
    });
    const note = await owner.call('PATCH', `/api/tickets/${t.id}`, { note: 'Still noted' });
    expect(note.body.value.note).toBe('Still noted');
    const del = await owner.call('DELETE', `/api/tickets/${t.id}`);
    expect(del.status).toBe(403);
    expect(del.body.rule).toBe('record_frozen');
  });

  it('its children refuse a tree write, and are not reachable one by one', async () => {
    const again = await plan(owner, t.id);
    expect(again.status).toBe(403);
    expect(again.body.rule).toBe('record_frozen');
    const [first] = await steps(t.id);
    const direct = await owner.call('PATCH', `/api/ticketSteps/${first.id}`, { title: 'Sneaky' });
    expect([403, 404]).toContain(direct.status);
    expect((await steps(t.id)).map((s) => s.title).sort()).toEqual(['Fix', 'Look', 'Measure']);
  });

  it('its state still moves, and moving out of a frozen state thaws it', async () => {
    const reopened = await owner.call('POST', `/api/transitions/tickets/${t.id}/reopen`, {});
    expect(reopened.body.value.status).toBe('open');
    const edit = await owner.call('PATCH', `/api/tickets/${t.id}`, { title: 'Thawed' });
    expect(edit.body.value.title).toBe('Thawed');
  });
});

describe('revisions', () => {
  let v1: Ticket;
  let v2: Ticket;

  it('revising copies the record and its whole tree as v2 in one write, audited', async () => {
    v1 = await create(owner, 'Revised', { note: 'Owner note' });
    await plan(owner, v1.id);
    await resolve(owner, v1.id);
    const res = await owner.call('POST', `/api/tickets/${v1.id}/revise`, {});
    expect(res.status).toBe(200);
    v2 = res.body.value.ticket;
    expect(v2).toMatchObject({
      title: 'Revised',
      status: 'open',
      version: 1,
      revision: 2,
      seriesId: v1.id,
      note: 'Owner note',
    });
    expect(v2.id).not.toBe(v1.id);
    // The tree, copied with new ids and the same shape.
    const copied = await steps(v2.id);
    expect(copied.map((s) => s.title).sort()).toEqual(['Fix', 'Look', 'Measure']);
    const look = copied.find((s) => s.title === 'Look') as Step;
    expect(copied.find((s) => s.title === 'Measure')?.parentStepId).toBe(look.id);
    expect((await steps(v1.id)).map((s) => s.id)).not.toContain(look.id);
    // v1 is superseded (frozen), by a transition.
    expect(await get(v1.id)).toMatchObject({ status: 'superseded', revision: 1, seriesId: null });
    const { rows } = await pool.query(
      `select action from audit.events where request_id = (
         select request_id from audit.events where action = 'ticket.revise' and resource_id = $1
       )`,
      [v1.id],
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      'ticket.create',
      'ticket.revise',
      'ticket.update',
      'ticketStep.create',
      'ticketStep.create',
      'ticketStep.create',
    ]);
  });

  it('refuses to revise a superseded revision; the next revision is v3 of the same series', async () => {
    const again = await owner.call('POST', `/api/tickets/${v1.id}/revise`, {});
    expect(again.body.rule).toBe('revise_resolved_only');
    await resolve(owner, v2.id);
    const v3 = (await owner.call('POST', `/api/tickets/${v2.id}/revise`, {})).body.value.ticket;
    expect(v3).toMatchObject({ revision: 3, seriesId: v1.id, status: 'open' });
  });

  it('lists the revisions of a series, oldest first, as the record reads', async () => {
    const res = await owner.call(
      'GET',
      `/api/history/versions?resourceType=ticket&resourceId=${v2.id}`,
    );
    expect(res.status).toBe(200);
    expect(
      res.body.map((v: { revision: number; state: string; frozen: boolean; current: boolean }) => [
        v.revision,
        v.state,
        v.frozen,
        v.current,
      ]),
    ).toEqual([
      [1, 'superseded', true, false],
      [2, 'superseded', true, true],
      [3, 'open', false, false],
    ]);
    expect(res.body[0].record.note).toBe('Owner note');
  });

  it('another business gets 404 for the versions; a hidden field stays hidden', async () => {
    const theirs = await stranger.call(
      'GET',
      `/api/history/versions?resourceType=ticket&resourceId=${v1.id}`,
    );
    expect(theirs.status).toBe(404);
    // Staff reach their own tickets; the owner notes one, and revises it.
    const own = await create(staff, 'Staff revised', {}, inTenant());
    await owner.call('PATCH', `/api/tickets/${own.id}`, { note: 'Not for staff' });
    await resolve(staff, own.id, inTenant());
    const revised = await staff.call('POST', `/api/tickets/${own.id}/revise`, {}, inTenant());
    expect(revised.status).toBe(200);
    expect(revised.body.value.ticket).not.toHaveProperty('note');
    const list = await staff.call(
      'GET',
      `/api/history/versions?resourceType=ticket&resourceId=${own.id}`,
      undefined,
      inTenant(),
    );
    expect(list.body).toHaveLength(2);
    for (const v of list.body) expect(v.record).not.toHaveProperty('note');
    // The owner's revisions are not theirs.
    const notTheirs = await staff.call(
      'GET',
      `/api/history/versions?resourceType=ticket&resourceId=${v1.id}`,
      undefined,
      inTenant(),
    );
    expect(notTheirs.status).toBe(404);
  });

  it("the assistant's revise waits, and runs on approval", async () => {
    const t = await create(owner, 'Asked revise');
    await resolve(owner, t.id);
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', `/api/tickets/${t.id}/revise`, {});
    expect(parked.body.status).toBe('needs_approval');
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
    expect((await get(t.id)).status).toBe('superseded');
  });
});
