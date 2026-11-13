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
    const made = await chore(owner, { title: '  Sweep the floor  ' });
    expect(made.status).toBe(201);
    // toJson trimmed the title; toValues gave it a due date.
    expect(made.body.value).toMatchObject({ title: 'Sweep the floor', dueOn: '2030-01-01' });
    const { rows } = await pool.query(
      'select title, tenant_id, owner_id, due_on::text as due_on from app.fixture_tasks where id = $1',
      [made.body.value.id],
    );
    expect(rows[0]).toEqual({
      title: '  Sweep the floor  ',
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

  it("a plugin's decision parks at a level, decided by a capability; the park is audited", async () => {
    const made = await chore(owner, { title: 'Photos' });
    const id = made.body.value.id;
    const res = await owner.call('PATCH', `/api/chores/${id}`, { title: '[review] Send photos' });
    const level = { name: 'fixture_review', rank: 2, label: { en: 'Review' } };
    expect(res.body).toMatchObject({
      status: 'needs_approval',
      approval: { rule: 'chore_review', level, canDecide: false },
    });
    const approvalId = res.body.approval.id;
    const { rows } = await pool.query(
      'select approver_user_id, approver_capability, level from app.approvals where id = $1',
      [approvalId],
    );
    expect(rows[0]).toEqual({
      approver_user_id: null,
      approver_capability: 'fixture.chores.review',
      level: 'fixture_review',
    });
    expect(await audit(id)).toContainEqual(
      expect.objectContaining({
        action: 'chore.update',
        outcome: 'needs_approval',
        after: expect.objectContaining({ approvalId, level: 'fixture_review' }),
      }),
    );
    // The capability's holders decide; the requester may look, never decide.
    const own = await owner.call('GET', `/api/approvals/${approvalId}`);
    expect(own.body).toMatchObject({ canDecide: false, decider: { by: 'capability' } });
    const ownTry = await owner.call('POST', `/api/approvals/${approvalId}/approve`);
    expect(ownTry.status).toBe(403);
    expect(ownTry.body).toMatchObject({ rule: 'own_request' });
    const seen = await admin.call('GET', `/api/approvals/${approvalId}`, undefined, inTenant());
    expect(seen.body).toMatchObject({
      level,
      canDecide: true,
      input: { title: '[review] Send photos' },
    });
    const approved = await admin.call(
      'POST',
      `/api/approvals/${approvalId}/approve`,
      undefined,
      inTenant(),
    );
    expect(approved.body).toMatchObject({ status: 'approved', level });
    expect((await owner.call('GET', `/api/chores/${id}`)).body.title).toBe('[review] Send photos');
  });

  it("the assistant says the team was asked for a request a capability's holders decide (V7)", async () => {
    // The owner's own request, through the assistant: the reviewers decide it, never her.
    const turn = await owner.call('POST', '/api/chat/once', {
      message: 'chore [review] Fix the roof',
    });
    expect(turn.status).toBeLessThan(300);
    const parked = (
      turn.body.toolCalls as { tool: string; outcome: string; approvalId?: string }[]
    ).filter((c) => c.tool === 'create-chore');
    expect(parked).toEqual([expect.objectContaining({ outcome: 'parked' })]);
    expect(turn.body.reply).toMatch(/^I've asked the team for approval: .+Fix the roof/);
    expect(turn.body.reply).toContain('Nothing changes until they decide.');
    expect(turn.body.reply).not.toMatch(/your approval|until you approve/);
    const approval = await owner.call('GET', `/api/approvals/${parked[0].approvalId}`);
    expect(approval.body).toMatchObject({ canDecide: false, rule: 'chore_review' });
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
    const made = await chore(owner, { title: 'Order paper' });
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
    expect(res.body.value).toEqual({
      chore: expect.objectContaining({ title: 'Staff chore, renamed' }),
    });
    // The entity's projection hid dueOn; the read projector, by the command's name, hid `was`.
    expect(res.body.value.chore).not.toHaveProperty('dueOn');
    const asAdmin = await admin.call(
      'POST',
      `/api/chores/${id}/rename`,
      { title: 'Staff chore, again' },
      inTenant(),
    );
    expect(asAdmin.body.value).toMatchObject({
      was: 'Staff chore, renamed',
      chore: { dueOn: '2026-12-01' },
    });
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
    // The read projector for 'approval' ran too.
    expect(seen.body).toMatchObject({ id: approvalId, rule: 'chore_title_asks' });
    expect(seen.body).not.toHaveProperty('reason');
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
    const made = await chore(owner, { title: 'Report [review] draft' });
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
    // This person's refusals: the database outlives a test run.
    const refusals = async () =>
      (
        await pool.query(
          `select count(*)::int as n from audit.events
           where action = 'chore.create' and outcome = 'denied' and rule = 'fixture_closed'
             and actor_id = $1`,
          [owner.id],
        )
      ).rows[0].n;
    expect(await refusals()).toBe(0);
    gate.closed = true;
    try {
      const res = await chore(owner, { title: 'Closed gate' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ rule: 'fixture_closed' });
    } finally {
      gate.closed = false;
    }
    expect(await refusals()).toBe(1);
    const stored = await pool.query(
      `select count(*)::int as n from app.domain_events where row->>'title' = 'Closed gate' and actor_id = $1`,
      [owner.id],
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

  it('a refused replay approved twice at once fails once, beside one audit of its refusal', async () => {
    const made = await chore(owner, { title: 'Gate twice' });
    const res = await owner.call('PATCH', `/api/chores/${made.body.value.id}`, {
      title: 'Gate twice [ask]',
    });
    const id = res.body.approval.id;
    gate.closed = true;
    let both: { status: number }[];
    try {
      both = await Promise.all([
        owner.call('POST', `/api/approvals/${id}/approve`),
        owner.call('POST', `/api/approvals/${id}/approve`),
      ]);
    } finally {
      gate.closed = false;
    }
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = (await audit(made.body.value.id)).filter((a) => a.outcome === 'denied');
    expect(refused).toMatchObject([{ action: 'chore.update', rule: 'fixture_closed' }]);
    expect((await audit(id)).filter((a) => a.action === 'approval.failed')).toHaveLength(1);
  });

  it('more refused replays at once than the pool holds all fail, each audited once; nothing else waits', async () => {
    // A replay runs in the approval's transaction: its refusal's audit row must take no second
    // pooled connection while that one is held, or enough of them at once stall the API.
    const { sharedDb } = await import('../../dist/infra/db.js');
    const n = 2 * ((sharedDb.pool.options.max as number | undefined) ?? 10) + 2;
    const park = async (tag: string) => {
      const out: { approval: string; chore: string }[] = [];
      for (let i = 0; i < n; i++) {
        const made = await chore(owner, { title: `${tag} ${i}` });
        const res = await owner.call('PATCH', `/api/chores/${made.body.value.id}`, {
          title: `${tag} ${i} [ask]`,
        });
        out.push({ approval: res.body.approval.id, chore: made.body.value.id });
      }
      return out;
    };
    const warm = await park('Warm');
    const asked = await park('Burst');
    // As many that run first: warm, every approval reaches its transaction at the same moment.
    const ran = await Promise.all(
      warm.map((a) => owner.call('POST', `/api/approvals/${a.approval}/approve`)),
    );
    expect(ran.map((r) => r.body.status)).toEqual(Array(n).fill('approved'));
    gate.closed = true;
    try {
      const started = Date.now();
      const all = Promise.all(
        asked.map((a) => owner.call('POST', `/api/approvals/${a.approval}/approve`)),
      );
      await new Promise((r) => setTimeout(r, 200));
      const asking = Date.now();
      expect((await owner.call('GET', '/api/me')).status).toBe(200);
      expect(Date.now() - asking).toBeLessThan(5_000);
      const decided = await all;
      expect(decided.map((r) => r.body.status)).toEqual(Array(n).fill('failed'));
      // Well under the pool's 30 s connection timeout, which a stall would take.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      gate.closed = false;
    }
    const { rows } = await pool.query(
      `select resource_id, count(*)::int as n from audit.events
       where action = 'chore.update' and outcome = 'denied' and rule = 'fixture_closed'
         and resource_id = any($1) group by resource_id`,
      [asked.map((a) => a.chore)],
    );
    expect(rows).toHaveLength(n);
    expect(rows.every((r) => r.n === 1)).toBe(true);
  }, 90_000);

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

  it('holds back the events of a write with an undo window, and answers with its undo', async () => {
    const made = await chore(owner, { title: 'Undoable' });
    const done = await owner.call('PATCH', `/api/chores/${made.body.value.id}`, { done: true });
    expect(done.body).toMatchObject({ status: 'done', undo: { id: expect.any(String) } });
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

describe('an update with nothing to change', () => {
  it('is refused as a 400, never a bare 500', async () => {
    const made = await chore(owner, { title: 'Unchanged' });
    const res = await owner.call('PATCH', `/api/chores/${made.body.value.id}`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('nothing_to_change');
    expect((await owner.call('GET', `/api/chores/${made.body.value.id}`)).body.title).toBe(
      'Unchanged',
    );
  });

  it('a parked update the erasure scrub emptied ends failed on approve, once; a second approve is 409', async () => {
    // A record blanked rather than deleted (erase: 'anonymise') keeps its pending update, with
    // every personal field taken out of the stored input. {} still validates, so the replay
    // reaches the row with nothing to set: it must end as failed, not as a 500 left pending.
    const { redactCopies } = await import('../../dist/index.js');
    const made = await chore(owner, { title: 'Call Ravi' });
    const id = made.body.value.id as string;
    const parked = await owner.call('PATCH', `/api/chores/${id}`, {
      title: 'Call Ravi again [ask]',
    });
    const approvalId = parked.body.approval.id as string;
    await db().transaction((tx) =>
      redactCopies(tx, tenantId, [{ type: 'chore', ids: [id], fields: ['title'] }]),
    );
    const { rows } = await pool.query(
      `select payload->'input' as input from app.approvals where id = $1`,
      [approvalId],
    );
    expect(rows[0].input).toEqual({});
    const first = await owner.call('POST', `/api/approvals/${approvalId}/approve`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('othing'),
    });
    expect((await owner.call('POST', `/api/approvals/${approvalId}/approve`)).status).toBe(409);
    expect((await audit(approvalId)).filter((a) => a.action === 'approval.failed')).toHaveLength(1);
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
    await chore(owner, { title: 'Order apples' });
    await chore(owner, { title: 'Count applesauce' });
    const res = await owner.call('GET', '/api/chores?title[hasWord]=apples');
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { title: string }) => c.title)).toEqual(['Order apples']);
    expect((await owner.call('GET', '/api/chores?title[hasWord]=a%20b')).status).toBe(400);
    expect((await owner.call('GET', '/api/chores?title[contains]=tiles')).status).toBe(400);
  });
});
