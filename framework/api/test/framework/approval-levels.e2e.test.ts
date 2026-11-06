// Approval levels (A5): levels the application declares, a level rule on the input, the row and
// the business's settings (a threshold, an approver per amount band), who decides (by capability,
// a named person, never the requester), where and how surely, expiry and its sweeper, approved
// replays bounded by what was approved, and undoing a write within its window. The fixture's
// features/approval-levels declares the levels; the framework declares none.
import { capabilitiesOf, type Principal } from '@hykr/contracts';
import { ApprovalService } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as api from '../../dist/index.js';
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
import { approvalLevelsApp } from '../fixture/dist/features/approval-levels/index.js';

const owner = new Person('Owner Levels');
const ops = new Person('Ops Levels');
const admin = new Person('Admin Levels');
const staff = new Person('Staff Levels');
const lead = new Person('Lead Levels');
const outsider = new Person('Outsider Levels');
const stranger = new Person('Stranger Levels');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
/** Members other than the owner work in the owner's business; everyone else in their own. */
const as = (p: Person) => ([ops, admin, staff, lead].includes(p) ? inTenant() : {});

const eur = (minor: number) => ({ minor, currency: 'EUR' });
const LIMIT = { 'payments.limit': eur(100_00) };
const final = { name: 'fixture_final', rank: 3, label: { en: 'Final' } };

/** This business's approval settings, replaced. */
async function approvalsSettings(approvals: object) {
  await pool.query(
    `update app.tenants set settings = jsonb_set(settings, '{approvals}', $2::jsonb) where id = $1`,
    [tenantId, JSON.stringify(approvals)],
  );
}

const pay = (person: Person, amountMinor: number, extra: object = {}) =>
  person.call(
    'POST',
    '/api/payments',
    { title: `Pay ${amountMinor}`, amountMinor, currency: 'EUR', ...extra },
    as(person),
  );
const approve = (person: Person, id: string) =>
  person.call('POST', `/api/approvals/${id}/approve`, undefined, as(person));
const look = (person: Person, id: string) =>
  person.call('GET', `/api/approvals/${id}`, undefined, as(person));
const undo = (person: Person, id: string) =>
  person.call('POST', `/api/undo/${id}`, undefined, as(person));

const audit = async (resourceId: string) =>
  (
    await pool.query(
      `select action, outcome, rule, actor_kind, request_id, after from audit.events
       where resource_id = $1 order by at`,
      [resourceId],
    )
  ).rows;

const approvals = () => server.app?.get(ApprovalService, { strict: false }) as ApprovalService;

beforeAll(async () => {
  await boot(approvalLevelsApp);
  for (const p of [owner, ops, admin, staff, lead, outsider, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(ops, tenantId, ['ops']);
  await addMember(admin, tenantId, ['admin']);
  await addMember(staff, tenantId, ['staff']);
  await addMember(lead, tenantId, ['staff']);
});
afterAll(shutdown);

describe('levels on the payload', () => {
  it('with no threshold set every payment is final: it waits for the business, never the requester', async () => {
    await approvalsSettings({});
    const res = await pay(owner, 10_00);
    expect(res.body).toMatchObject({
      status: 'needs_approval',
      approval: {
        rule: 'payment_over_limit',
        level: final,
        amount: eur(10_00),
        canDecide: false,
        decider: { by: 'capability', capability: 'approvals.decide' },
      },
    });
    const { id, expiresAt } = res.body.approval;
    // The level's own expiry: five minutes.
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const { rows } = await pool.query(
      `select action, outcome, after from audit.events where after->>'approvalId' = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({
      action: 'payment.create',
      outcome: 'needs_approval',
      after: { approvalId: id, level: 'fixture_final' },
    });
    // The owner holds approvals.decide, but asked: they may look, never decide.
    expect((await look(owner, id)).body).toMatchObject({ canDecide: false });
    expect(await approve(owner, id)).toMatchObject({
      status: 403,
      body: { rule: 'own_request' },
    });
    expect(
      (await owner.call('GET', '/api/approvals')).body.map((a: { id: string }) => a.id),
    ).not.toContain(id);
    // Another holder decides it.
    expect((await look(ops, id)).body).toMatchObject({ canDecide: true });
    expect((await approve(ops, id)).body).toMatchObject({ status: 'approved', level: final });
  });

  it('within the threshold it runs and can be undone; above it, it waits', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const small = await pay(owner, 50_00);
    expect(small.body).toMatchObject({
      status: 'done',
      value: { amountMinor: 50_00 },
      undo: { id: expect.any(String), until: expect.any(String) },
    });
    const window = Date.parse(small.body.undo.until) - Date.now();
    expect(window).toBeGreaterThan(25_000);
    expect(window).toBeLessThanOrEqual(30_000);
    const big = await pay(owner, 500_00);
    expect(big.body).toMatchObject({ status: 'needs_approval', approval: { level: final } });
  });

  it('a named approver per amount band decides alone, in the app, signed in', async () => {
    await approvalsSettings({
      thresholds: LIMIT,
      bands: {
        payments: [
          { upTo: eur(1_000_00), approver: { userId: lead.id } },
          { approver: { capability: 'fixture.payments.approve' } },
        ],
      },
    });
    const res = await pay(owner, 500_00);
    const id = res.body.approval.id;
    expect(res.body.approval).toMatchObject({ decider: { by: 'person', userId: lead.id } });
    // Nobody else may see it: holders of approvals.decide included.
    expect((await look(ops, id)).status).toBe(404);
    expect((await look(admin, id)).status).toBe(404);
    expect((await look(lead, id)).body).toMatchObject({ canDecide: true, level: final });
    // Not over WhatsApp, and not on a number alone.
    const onWhatsApp: Principal = {
      actor: { kind: 'user', id: lead.id },
      subject: { kind: 'user', userId: lead.id },
      tenantId,
      roles: ['staff'],
      capabilities: capabilitiesOf(['staff']),
      assurance: 'whatsapp_number',
      channel: 'whatsapp',
      scopes: [],
    };
    await expect(approvals().decide(onWhatsApp, id, true, 'r-wa')).rejects.toMatchObject({
      response: { rule: 'decide_elsewhere' },
    });
    await expect(
      approvals().decide({ ...onWhatsApp, channel: 'app' }, id, true, 'r-num'),
    ).rejects.toMatchObject({ response: { rule: 'needs_assurance' } });
    expect((await approve(lead, id)).body).toMatchObject({ status: 'approved' });

    // The band above: any holder of the band's capability (admins), not the business's deciders.
    const bigger = await pay(owner, 5_000_00);
    const biggerId = bigger.body.approval.id;
    expect(bigger.body.approval.decider).toEqual({
      by: 'capability',
      capability: 'fixture.payments.approve',
    });
    expect((await look(ops, biggerId)).status).toBe(404);
    expect((await approve(admin, biggerId)).body).toMatchObject({ status: 'approved' });
  });

  it('a named approver who asked, or who is not in the business, gives way to the business', async () => {
    await approvalsSettings({
      thresholds: LIMIT,
      bands: { payments: [{ approver: { userId: lead.id } }] },
    });
    const asked = await pay(lead, 500_00);
    const id = asked.body.approval.id;
    expect(asked.body.approval).toMatchObject({
      canDecide: false,
      decider: { by: 'capability', capability: 'approvals.decide' },
    });
    expect((await approve(lead, id)).status).toBe(403);
    expect((await approve(owner, id)).body).toMatchObject({ status: 'approved' });

    await approvalsSettings({
      thresholds: LIMIT,
      bands: { payments: [{ approver: { userId: outsider.id } }] },
    });
    const away = await pay(owner, 500_00);
    expect(away.body.approval.decider).toEqual({
      by: 'capability',
      capability: 'approvals.decide',
    });
    expect((await look(outsider, away.body.approval.id)).status).toBe(404);
  });

  it('a business tightens any level, and loosens only one that allows it', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const made = await pay(owner, 20_00);
    const paymentId = made.body.value.id;
    const assistant = asAssistant(`user:${owner.id}`);
    // Outside: the assistant's send waits for the person it is for; the person's own runs.
    const sent = await assistant('POST', `/api/payments/${paymentId}/send`, {});
    expect(sent.body).toMatchObject({
      status: 'needs_approval',
      approval: { level: { name: 'fixture_outside' }, decider: { by: 'requester' } },
    });
    expect((await approve(owner, sent.body.approval.id)).body).toMatchObject({
      status: 'approved',
    });
    expect((await owner.call('POST', `/api/payments/${paymentId}/send`, {})).body).toMatchObject({
      status: 'done',
    });

    await approvalsSettings({
      thresholds: LIMIT,
      levels: { fixture_outside: { parks: false }, fixture_final: { parks: false } },
    });
    expect((await assistant('POST', `/api/payments/${paymentId}/send`, {})).body).toMatchObject({
      status: 'done',
    });
    // fixture_final lets no business loosen it.
    expect((await pay(owner, 500_00)).body.status).toBe('needs_approval');

    await approvalsSettings({ thresholds: LIMIT, levels: { fixture_internal: { parks: true } } });
    const tight = await pay(owner, 20_00);
    expect(tight.body).toMatchObject({
      status: 'needs_approval',
      approval: { level: { name: 'fixture_internal' }, decider: { by: 'requester' } },
    });
  });
});

describe('expiry', () => {
  it("a business's expiry for a level replaces the level's own", async () => {
    await approvalsSettings({
      thresholds: LIMIT,
      levels: { fixture_final: { expiresInMs: 120_000 } },
    });
    const res = await pay(owner, 500_00);
    const left = Date.parse(res.body.approval.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(100_000);
    expect(left).toBeLessThanOrEqual(120_000);
  });

  it('the sweeper expires what nobody decided: audited as the system, and stored as decided', async () => {
    expect(api.schedules.get('approvals.expire')).toMatchObject({
      queue: 'approvals.expire',
      every: 60_000,
    });
    expect(api.queues.has('approvals.expire')).toBe(true);
    await approvalsSettings({ thresholds: LIMIT });
    const res = await pay(owner, 500_00);
    const id = res.body.approval.id;
    await pool.query(
      `update app.approvals set expires_at = now() - interval '1 second' where id = $1`,
      [id],
    );
    await approvals().expireDue();
    const { rows } = await pool.query(
      'select status, decided_by from app.approvals where id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ status: 'expired', decided_by: 'system' });
    expect(await audit(id)).toContainEqual(
      expect.objectContaining({
        action: 'approval.expired',
        actor_kind: 'system',
        rule: 'approval_expired',
      }),
    );
    const events = await pool.query(
      `select name, row->>'status' as status from app.domain_events where resource_id = $1 order by seq`,
      [id],
    );
    expect(events.rows).toEqual([
      { name: 'approval.requested', status: 'pending' },
      { name: 'approval.decided', status: 'expired' },
    ]);
    expect((await approve(ops, id)).status).toBe(409);
  });
});

describe('an approved replay is bounded by what was approved', () => {
  it('fails when its level is higher now', async () => {
    await approvalsSettings({ thresholds: LIMIT, levels: { fixture_internal: { parks: true } } });
    const res = await pay(owner, 50_00, { title: 'Rose since' });
    expect(res.body.approval.level.name).toBe('fixture_internal');
    // The business lowers its limit: the same payment is final now.
    await approvalsSettings({
      thresholds: { 'payments.limit': eur(10_00) },
      levels: { fixture_internal: { parks: true } },
    });
    expect((await approve(owner, res.body.approval.id)).body).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/more approval/),
    });
    const { rows } = await pool.query(
      `select count(*)::int as n from app.fixture_levels_payments where title = 'Rose since' and tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('fails when its amount grew', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const made = await pay(owner, 50_00);
    const paymentId = made.body.value.id;
    await approvalsSettings({ thresholds: LIMIT, levels: { fixture_internal: { parks: true } } });
    const res = await owner.call('PATCH', `/api/payments/${paymentId}`, { title: 'Renamed' });
    expect(res.body.approval).toMatchObject({ amount: eur(50_00) });
    await pool.query('update app.fixture_levels_payments set amount_minor = 80_00 where id = $1', [
      paymentId,
    ]);
    expect((await approve(owner, res.body.approval.id)).body).toMatchObject({ status: 'failed' });
  });
});

describe('who sees what', () => {
  it('a field hidden from staff stays hidden on the approval card', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const res = await pay(staff, 500_00, { note: 'staff never sees this' });
    expect(res.body.status).toBe('needs_approval');
    expect(res.body.approval.input).not.toHaveProperty('note');
    const own = await look(staff, res.body.approval.id);
    expect(own.body).toMatchObject({ canDecide: false });
    expect(own.body.input).not.toHaveProperty('note');
    const seen = await look(ops, res.body.approval.id);
    expect(seen.body.input).toMatchObject({ note: 'staff never sees this' });
  });

  it('another business gets a 404 for an approval and an undo', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const parked = await pay(owner, 500_00);
    const done = await pay(owner, 10_00);
    expect((await look(stranger, parked.body.approval.id)).status).toBe(404);
    expect((await approve(stranger, parked.body.approval.id)).status).toBe(404);
    expect((await undo(stranger, done.body.undo.id)).status).toBe(404);
    // Someone else in the business, too: an undo is the person's own.
    expect((await undo(ops, done.body.undo.id)).status).toBe(404);
  });
});

describe('undo within the window', () => {
  const events = async (resourceId: string) =>
    (
      await pool.query(
        `select name, cancelled_at is not null as cancelled,
                extract(epoch from (available_at - occurred_at))::int as held
         from app.domain_events where resource_id = $1 order by seq`,
        [resourceId],
      )
    ).rows;

  it('a create is undone: the row goes, its held events are withdrawn, and it is audited', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const made = await pay(owner, 10_00);
    const paymentId = made.body.value.id;
    expect(await events(paymentId)).toEqual([
      { name: 'payment.created', cancelled: false, held: 30 },
    ]);
    const res = await undo(owner, made.body.undo.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: made.body.undo.id,
      undone: true,
      action: 'payment.create',
      resourceType: 'payment',
      resourceId: null,
    });
    expect((await owner.call('GET', `/api/payments/${paymentId}`)).status).toBe(404);
    // Withdrawn, and the reversal stored nothing: subscribers never see the payment.
    expect(await events(paymentId)).toEqual([
      { name: 'payment.created', cancelled: true, held: 30 },
    ]);
    const trail = await audit(paymentId);
    expect(trail.map((r) => r.action)).toEqual(['payment.create', 'payment.delete']);
    expect(trail[1]).toMatchObject({ rule: 'undo_own_write' });
    expect(await undo(owner, made.body.undo.id)).toMatchObject({
      status: 409,
      body: { error: 'already_undone' },
    });
  });

  it('an update gets its fields back; a delete puts the row back as it was', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const made = await pay(owner, 10_00, { title: 'Before' });
    const paymentId = made.body.value.id;
    const changed = await owner.call('PATCH', `/api/payments/${paymentId}`, {
      title: 'After',
      amountMinor: 20_00,
    });
    expect((await undo(owner, changed.body.undo.id)).status).toBe(200);
    expect((await owner.call('GET', `/api/payments/${paymentId}`)).body).toMatchObject({
      title: 'Before',
      amountMinor: 10_00,
    });

    const removed = await owner.call('DELETE', `/api/payments/${paymentId}`);
    expect(removed.body).toMatchObject({ status: 'done', undo: { id: expect.any(String) } });
    expect((await owner.call('GET', `/api/payments/${paymentId}`)).status).toBe(404);
    expect((await undo(owner, removed.body.undo.id)).status).toBe(200);
    expect((await owner.call('GET', `/api/payments/${paymentId}`)).body).toMatchObject({
      id: paymentId,
      title: 'Before',
      amountMinor: 10_00,
    });
  });

  it('refuses when it changed since, after the window, or once its events were passed on', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const made = await pay(owner, 10_00);
    const paymentId = made.body.value.id;
    await owner.call('PATCH', `/api/payments/${paymentId}`, { title: 'Changed since' });
    expect(await undo(owner, made.body.undo.id)).toMatchObject({
      status: 409,
      body: { error: 'changed_since' },
    });
    expect((await owner.call('GET', `/api/payments/${paymentId}`)).status).toBe(200);

    const late = await pay(owner, 10_00);
    await pool.query(
      `update app.undo_windows set until = now() - interval '1 second' where id = $1`,
      [late.body.undo.id],
    );
    expect(await undo(owner, late.body.undo.id)).toMatchObject({
      status: 403,
      body: { rule: 'undo_window_closed' },
    });

    const passed = await pay(owner, 10_00);
    await pool.query('update app.domain_events set relayed_at = now() where resource_id = $1', [
      passed.body.value.id,
    ]);
    expect(await undo(owner, passed.body.undo.id)).toMatchObject({
      status: 409,
      body: { error: 'too_late' },
    });
    expect((await owner.call('GET', `/api/payments/${passed.body.value.id}`)).status).toBe(200);
  });

  it("a write the assistant made for a person is the person's to undo", async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const made = await asAssistant(`user:${owner.id}`)('POST', '/api/payments', {
      title: 'By the assistant',
      amountMinor: 10_00,
      currency: 'EUR',
    });
    expect(made.body).toMatchObject({ status: 'done', undo: { id: expect.any(String) } });
    expect((await undo(owner, made.body.undo.id)).status).toBe(200);
  });

  it('a write that parked, or that ran after approval, opens no undo window', async () => {
    await approvalsSettings({ thresholds: LIMIT });
    const windows = async () =>
      (
        await pool.query('select count(*)::int as n from app.undo_windows where tenant_id = $1', [
          tenantId,
        ])
      ).rows[0].n;
    const before = await windows();
    const res = await pay(owner, 500_00);
    expect(res.body).not.toHaveProperty('undo');
    expect((await approve(ops, res.body.approval.id)).body).toMatchObject({ status: 'approved' });
    expect(await windows()).toBe(before);
  });
});
