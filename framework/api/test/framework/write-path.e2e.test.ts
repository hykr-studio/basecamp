// The core write and read path (F3): entity plugins, principal-aware reads on every path a
// record leaves by, write hooks, the durable event outbox, and the registries (ops, entities,
// list field types). The fixture's `chore` entity carries the plugin's trait
// (fixture/src/features/write-path).
import type { DomainEventEnvelope, Principal } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  entityDefs,
  eventFor,
  registerEntityDef,
  registerOp,
  toEnvelope,
} from '@hykr/core';
import { domainEvents } from '@hykr/db';
import { EventBus } from '@nestjs/cqrs';
import { asc, eq } from 'drizzle-orm';
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
import { ChoreDef, gate, writePath } from '../fixture/dist/features/write-path/index.js';

const owner = new Person('Owner Writes');
const staff = new Person('Staff Writes');
const admin = new Person('Admin Writes');
const stranger = new Person('Stranger Writes');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const db = () => {
  if (!server.app) throw new Error('The app is not booted');
  return (server.app.get(CORE_OPTIONS, { strict: false }) as CoreOptions).db;
};

/** As the server builds it for a signed-in person in the business. */
const principalOf = (person: Person, roles: string[], tenant = tenantId): Principal => ({
  actor: { kind: 'user', id: person.id, role: 'owner' },
  subject: { kind: 'user', userId: person.id },
  tenantId: tenant,
  roles: roles as Principal['roles'],
  assurance: 'session',
  scopes: [],
});

/** The stored events about one record, oldest first. */
async function eventsOf(resourceId: string): Promise<DomainEventEnvelope[]> {
  const rows = await db()
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.resourceId, resourceId))
    .orderBy(asc(domainEvents.seq));
  return rows.map(toEnvelope);
}

const audit = async (resourceId: string) =>
  (
    await pool.query(
      'select action, outcome, rule, request_id, after from audit.events where resource_id = $1 order by at',
      [resourceId],
    )
  ).rows;

const chore = (person: Person, body: object) =>
  person.call('POST', '/api/chores', body, person === owner ? {} : inTenant());

beforeAll(async () => {
  await boot(writePath);
  for (const p of [owner, staff, admin, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(admin, tenantId, ['admin']);
});
afterAll(shutdown);

describe('entity plugins', () => {
  it('toValues sets a column the input cannot, never the business or the owner; toJson runs before parsing', async () => {
    const made = await chore(owner, { title: '  Sweep the site  ' });
    expect(made.status).toBe(201);
    // toJson trimmed the title; toValues gave it a due date.
    expect(made.body.value).toMatchObject({ title: 'Sweep the site', dueOn: '2030-01-01' });
    const { rows } = await pool.query(
      'select title, tenant_id, owner_id, due_on::text as due_on from app.fixture_tasks where id = $1',
      [made.body.value.id],
    );
    expect(rows[0]).toEqual({
      title: '  Sweep the site  ',
      tenant_id: tenantId,
      owner_id: owner.id,
      due_on: '2030-01-01',
    });
  });

  it("a plugin's rule refuses, and the refusal is audited", async () => {
    const made = await chore(owner, { title: '[keep] Fence' });
    const id = made.body.value.id;
    const res = await owner.call('DELETE', `/api/chores/${id}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'chore_keep' });
    expect(await audit(id)).toContainEqual(
      expect.objectContaining({ action: 'chore.delete', outcome: 'denied', rule: 'chore_keep' }),
    );
  });

  it("a plugin's decision parks with a tier and a named approver role; the park is audited", async () => {
    const made = await chore(owner, { title: 'Photos' });
    const id = made.body.value.id;
    const res = await owner.call('PATCH', `/api/chores/${id}`, { title: '[client] Send photos' });
    expect(res.body).toMatchObject({
      status: 'needs_approval',
      approval: { rule: 'chore_client_send', tier: 2 },
    });
    const approvalId = res.body.approval.id;
    const { rows } = await pool.query(
      'select approver_user_id, approver_roles from app.approvals where id = $1',
      [approvalId],
    );
    expect(rows[0]).toEqual({ approver_user_id: null, approver_roles: ['admin'] });
    expect(await audit(id)).toContainEqual(
      expect.objectContaining({
        action: 'chore.update',
        outcome: 'needs_approval',
        after: expect.objectContaining({ approvalId, tier: 2 }),
      }),
    );
    // The named role decides; the requester may not.
    expect((await owner.call('GET', `/api/approvals/${approvalId}`)).status).toBe(404);
    const seen = await admin.call('GET', `/api/approvals/${approvalId}`, undefined, inTenant());
    expect(seen.body).toMatchObject({ tier: 2, input: { title: '[client] Send photos' } });
    const approved = await admin.call(
      'POST',
      `/api/approvals/${approvalId}/approve`,
      undefined,
      inTenant(),
    );
    expect(approved.body).toMatchObject({ status: 'approved', tier: 2 });
    expect((await owner.call('GET', `/api/chores/${id}`)).body.title).toBe('[client] Send photos');
  });

  it("an entity's own rule parks a plain write", async () => {
    const made = await chore(owner, { title: 'Paint' });
    const res = await owner.call('PATCH', `/api/chores/${made.body.value.id}`, {
      title: 'Paint [ask]',
    });
    expect(res.body).toMatchObject({
      status: 'needs_approval',
      approval: { rule: 'chore_title_asks' },
    });
  });

  it('extra scope hides rows: out of reach is a 404, and not listed', async () => {
    const made = await chore(owner, { title: 'archived: Old skip' });
    const id = made.body.value.id;
    expect((await owner.call('GET', `/api/chores/${id}`)).status).toBe(404);
    expect((await owner.call('PATCH', `/api/chores/${id}`, { done: true })).status).toBe(404);
    const list = await owner.call('GET', '/api/chores');
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(id);
    // The same row is a task as ever: the plugin serves chores only.
    expect((await owner.call('GET', `/api/tasks/${id}`)).status).toBe(200);
  });

  it('a write from a stale read answers 409; a missing row is still a 404', async () => {
    const made = await chore(owner, { title: 'Order sand' });
    const p = principalOf(owner, ['owner']);
    const read = await ChoreDef.repo.get(db(), p, made.body.value.id);
    await owner.call('PATCH', `/api/chores/${read.id}`, { title: 'Order river sand' });
    await expect(
      db().transaction((tx) => ChoreDef.repo.update(tx, p, read, { done: true })),
    ).rejects.toMatchObject({ status: 409, response: { error: 'stale' } });
    await expect(db().transaction((tx) => ChoreDef.repo.delete(tx, p, read))).rejects.toMatchObject(
      { status: 409 },
    );
    const gone = { ...read, id: '00000000-0000-4000-8000-000000000000' };
    await expect(
      db().transaction((tx) => ChoreDef.repo.update(tx, p, gone, { done: true })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('a hidden field stays hidden wherever the record leaves', () => {
  let id = '';
  beforeAll(async () => {
    const made = await chore(staff, { title: 'Staff chore', dueOn: '2026-12-01' });
    expect(made.status).toBe(201);
    id = made.body.value.id;
    // Hidden from staff in the write's own answer.
    expect(made.body.value).not.toHaveProperty('dueOn');
  });

  it('get and list', async () => {
    const one = await staff.call('GET', `/api/chores/${id}`, undefined, inTenant());
    expect(one.body).toMatchObject({ id, title: 'Staff chore' });
    expect(one.body).not.toHaveProperty('dueOn');
    const list = await staff.call('GET', '/api/chores', undefined, inTenant());
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const item of list.body.items) expect(item).not.toHaveProperty('dueOn');
    // An admin sees it.
    const asAdmin = await admin.call('GET', `/api/chores/${id}`, undefined, inTenant());
    expect(asAdmin.body.dueOn).toBe('2026-12-01');
  });

  it("a command's result that reuses the entity's schema", async () => {
    const res = await staff.call(
      'POST',
      `/api/chores/${id}/rename`,
      { title: 'Staff chore, renamed' },
      inTenant(),
    );
    expect(res.status).toBe(200);
    expect(res.body.value).toMatchObject({
      was: 'Staff chore',
      chore: { title: 'Staff chore, renamed' },
    });
    expect(res.body.value.chore).not.toHaveProperty('dueOn');
  });

  it("a parked write's approval, though the stored payload keeps it", async () => {
    const res = await staff.call(
      'PATCH',
      `/api/chores/${id}`,
      { title: 'Staff [ask]', dueOn: '2026-12-24' },
      inTenant(),
    );
    expect(res.body.status).toBe('needs_approval');
    expect(res.body.approval.input).toEqual({ title: 'Staff [ask]' });
    const approvalId = res.body.approval.id;
    const seen = await staff.call('GET', `/api/approvals/${approvalId}`, undefined, inTenant());
    expect(seen.body.input).toEqual({ title: 'Staff [ask]' });
    const listed = await staff.call('GET', '/api/approvals', undefined, inTenant());
    const mine = listed.body.find((a: { id: string }) => a.id === approvalId);
    expect(mine.input).toEqual({ title: 'Staff [ask]' });
    const { rows } = await pool.query('select payload from app.approvals where id = $1', [
      approvalId,
    ]);
    expect(rows[0].payload.input).toMatchObject({ dueOn: '2026-12-24' });
  });

  it('a stored event, read for each reader', async () => {
    const created = (await eventsOf(id)).find((e) => e.name === 'chore.created');
    expect(created?.row).toMatchObject({ dueOn: '2026-12-01', tenantId, ownerId: staff.id });
    const forStaff = eventFor(created as DomainEventEnvelope, principalOf(staff, ['staff']));
    expect(forStaff?.row).toMatchObject({ id, title: 'Staff chore' });
    expect(forStaff?.row).not.toHaveProperty('dueOn');
    // Internal columns never leave either.
    expect(forStaff?.row).not.toHaveProperty('tenantId');
    const forAdmin = eventFor(created as DomainEventEnvelope, principalOf(admin, ['admin']));
    expect(forAdmin?.row).toMatchObject({ dueOn: '2026-12-01' });
  });

  it('history titles', async () => {
    const secret = await chore(staff, { title: 'secret: Surprise party' });
    const sid = secret.body.value.id;
    expect(secret.body.value).not.toHaveProperty('title');
    const history = await staff.call(
      'GET',
      `/api/history?resourceType=chore&resourceId=${sid}`,
      undefined,
      inTenant(),
    );
    expect(history.status).toBe(200);
    expect(history.body.map((h: { title: string | null }) => h.title)).toEqual([null]);
    const asAdmin = await admin.call(
      'GET',
      `/api/history?resourceType=chore&resourceId=${sid}`,
      undefined,
      inTenant(),
    );
    expect(asAdmin.body[0].title).toBe('secret: Surprise party');
  });
});

describe('another business', () => {
  it('gets a 404 for a chore, its approval, and nothing from its events', async () => {
    const made = await chore(owner, { title: 'Tile [client] quote' });
    expect(made.body.status).toBe('needs_approval');
    const approvalId = made.body.approval.id;
    const other = await chore(owner, { title: 'Private chore' });
    const id = other.body.value.id;
    expect((await stranger.call('GET', `/api/chores/${id}`)).status).toBe(404);
    expect((await stranger.call('PATCH', `/api/chores/${id}`, { done: true })).status).toBe(404);
    expect((await stranger.call('DELETE', `/api/chores/${id}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/approvals/${approvalId}`)).status).toBe(404);
    const [created] = await eventsOf(id);
    const strangerTenant = (await me(stranger)).tenantId;
    expect(eventFor(created, principalOf(stranger, ['owner'], strangerTenant))).toBeNull();
  });
});

describe('write hooks', () => {
  it('decide refuses while the gate is closed; the refusal is audited and stores no event', async () => {
    gate.closed = true;
    try {
      const res = await chore(owner, { title: 'Closed gate' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ rule: 'fixture_closed' });
    } finally {
      gate.closed = false;
    }
    const { rows } = await pool.query(
      `select count(*)::int as n from audit.events where action = 'chore.create' and outcome = 'denied' and rule = 'fixture_closed'`,
    );
    expect(rows[0].n).toBe(1);
    const stored = await pool.query(
      `select count(*)::int as n from app.domain_events where row->>'title' = 'Closed gate'`,
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("a hook's refusal still refuses an approved replay", async () => {
    const made = await chore(owner, { title: 'Gate replay' });
    const res = await owner.call('PATCH', `/api/chores/${made.body.value.id}`, {
      title: 'Gate [ask]',
    });
    gate.closed = true;
    try {
      const decided = await owner.call('POST', `/api/approvals/${res.body.approval.id}/approve`);
      expect(decided.body).toMatchObject({
        status: 'failed',
        failureReason: 'Chore writes are closed for now',
      });
    } finally {
      gate.closed = false;
    }
  });

  it('afterRun sees each write, done or parked', async () => {
    gate.seen.length = 0;
    const made = await chore(owner, { title: 'Seen' });
    await owner.call('PATCH', `/api/chores/${made.body.value.id}`, { title: 'Seen [ask]' });
    expect(gate.seen).toEqual([
      { op: 'chore.create', status: 'done', touched: 1 },
      { op: 'chore.update', status: 'needs_approval', touched: 0 },
    ]);
  });

  it('throwing from afterRun rolls the whole write back: no row, no audit, no event', async () => {
    gate.failAfterRun = true;
    try {
      expect((await chore(owner, { title: 'Rolled back' })).status).toBe(500);
    } finally {
      gate.failAfterRun = false;
    }
    for (const q of [
      `select count(*)::int as n from app.fixture_tasks where title = 'Rolled back'`,
      `select count(*)::int as n from audit.events where after->>'title' = 'Rolled back'`,
      `select count(*)::int as n from app.domain_events where row->>'title' = 'Rolled back'`,
    ])
      expect((await pool.query(q)).rows[0].n).toBe(0);
  });
});

describe('the durable event outbox', () => {
  it('stores create, update and delete in the write, with the record before', async () => {
    const made = await chore(owner, { title: 'Lifecycle' });
    const id = made.body.value.id;
    await owner.call('PATCH', `/api/chores/${id}`, { title: 'Lifecycle 2' });
    await owner.call('DELETE', `/api/chores/${id}`);
    const events = await eventsOf(id);
    expect(events.map((e) => e.name)).toEqual(['chore.created', 'chore.updated', 'chore.deleted']);
    const [created, updated, deleted] = events;
    expect(created).toMatchObject({
      tenantId,
      resourceType: 'chore',
      resourceId: id,
      actor: { kind: 'user', id: owner.id },
      subject: `user:${owner.id}`,
      row: { title: 'Lifecycle' },
    });
    expect(created.before).toBeUndefined();
    expect(created.availableAt).toBeUndefined();
    expect(updated).toMatchObject({
      row: { title: 'Lifecycle 2' },
      before: { title: 'Lifecycle' },
    });
    expect(deleted).toMatchObject({ before: { title: 'Lifecycle 2' } });
    // The same request as the audit row the write wrote with it.
    const rows = await audit(id);
    expect(rows.find((r) => r.action === 'chore.create')?.request_id).toBe(created.requestId);
    // Only this run's relay takes them.
    const { rows: stored } = await pool.query(
      'select distinct queues from app.domain_events where resource_id = $1',
      [id],
    );
    expect(stored).toEqual([{ queues: process.env.BULL_PREFIX }]);
  });

  it("holds back a tier 1 write's events for its undo window", async () => {
    const made = await chore(owner, { title: 'Undoable' });
    await owner.call('PATCH', `/api/chores/${made.body.value.id}`, { done: true });
    const updated = (await eventsOf(made.body.value.id)).find((e) => e.name === 'chore.updated');
    expect(updated?.availableAt).toBeDefined();
    const held = Date.parse(updated?.availableAt ?? '') - Date.parse(updated?.occurredAt ?? '');
    expect(held).toBe(60_000);
  });

  it('stores approval.requested and approval.decided, then the approved write', async () => {
    const made = await chore(owner, { title: 'Approve me' });
    const id = made.body.value.id;
    const asked = await owner.call('PATCH', `/api/chores/${id}`, { title: 'Approve me [ask]' });
    const approvalId = asked.body.approval.id;
    await owner.call('POST', `/api/approvals/${approvalId}/approve`);
    expect((await eventsOf(approvalId)).map((e) => e.name)).toEqual([
      'approval.requested',
      'approval.decided',
    ]);
    const [requested, decided] = await eventsOf(approvalId);
    expect(requested).toMatchObject({ resourceType: 'approval', row: { status: 'pending' } });
    expect(decided).toMatchObject({ row: { status: 'approved' } });
    // The approval's stored operation never travels with its events.
    expect(decided.row).not.toHaveProperty('payload');
    expect((await eventsOf(id)).map((e) => e.name)).toEqual(['chore.created', 'chore.updated']);
  });

  it('stores a rejected approval as decided', async () => {
    const made = await chore(owner, { title: 'Reject me' });
    const asked = await owner.call('PATCH', `/api/chores/${made.body.value.id}`, {
      title: 'Reject me [ask]',
    });
    await owner.call('POST', `/api/approvals/${asked.body.approval.id}/reject`);
    const [, decided] = await eventsOf(asked.body.approval.id);
    expect(decided).toMatchObject({ name: 'approval.decided', row: { status: 'rejected' } });
  });

  it("stores a command's event with its record and the record before", async () => {
    const made = await chore(owner, { title: 'Rename me' });
    const id = made.body.value.id;
    await owner.call('POST', `/api/chores/${id}/rename`, { title: 'Renamed' });
    const renamed = (await eventsOf(id)).find((e) => e.name === 'chore.renamed');
    expect(renamed).toMatchObject({
      resourceType: 'chore',
      resourceId: id,
      row: { title: 'Renamed' },
      before: { title: 'Rename me' },
    });
  });

  it("an assistant's write records the agent, whom it acted for, and the channel", async () => {
    const asAna = asAssistant(`user:${owner.id}`);
    const made = await asAna('POST', '/api/chores', { title: 'By the assistant' });
    expect(made.status).toBe(201);
    const [created] = await eventsOf(made.body.value.id);
    expect(created).toMatchObject({
      actor: { kind: 'agent', id: 'assistant' },
      subject: `user:${owner.id}`,
      channel: 'whatsapp',
    });
    expect(created.runId).toMatch(/^r/);
  });

  it('in-process subscribers still get each event after commit', async () => {
    const bus = server.app?.get(EventBus, { strict: false }) as EventBus;
    const seen: { eventName?: string; before?: unknown }[] = [];
    const sub = bus.subscribe((e) => seen.push(e as never));
    try {
      const made = await chore(owner, { title: 'Published' });
      await owner.call('PATCH', `/api/chores/${made.body.value.id}`, { title: 'Published 2' });
    } finally {
      sub.unsubscribe();
    }
    expect(seen.map((e) => e.eventName)).toEqual(['chore.created', 'chore.updated']);
    expect(seen[1].before).toMatchObject({ title: 'Published' });
  });
});

describe('registries', () => {
  it('an operation is registered for replay once', () => {
    expect(() => registerOp('chore.create', () => ({}) as never)).toThrow(
      'The operation "chore.create" is registered twice',
    );
    expect(() => registerOp('chore.rename', () => ({}) as never)).toThrow('registered twice');
  });

  it('entityDefs lists the served entities; a name is served once', () => {
    expect(entityDef('chore')).toBe(ChoreDef);
    expect(entityDefs().map((d) => d.name)).toEqual(
      expect.arrayContaining(['task', 'visit', 'page', 'chore']),
    );
    // Serving the same definition again is a no-op; another entity named chore is refused.
    expect(() => registerEntityDef(ChoreDef)).not.toThrow();
    const impostor = { ...ChoreDef, plural: 'impostors' };
    expect(() => registerEntityDef(impostor)).toThrow('The entity "chore" is registered twice');
  });

  it('a contributed list field type filters over HTTP, and refuses what it does not take', async () => {
    await chore(owner, { title: 'Order tiles' });
    await chore(owner, { title: 'Count tilesets' });
    const res = await owner.call('GET', '/api/chores?title[hasWord]=tiles');
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { title: string }) => c.title)).toEqual(['Order tiles']);
    expect((await owner.call('GET', '/api/chores?title[hasWord]=a%20b')).status).toBe(400);
    expect((await owner.call('GET', '/api/chores?title[contains]=tiles')).status).toBe(400);
  });
});
