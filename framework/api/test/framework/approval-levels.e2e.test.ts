// Approval levels (A5): levels the application declares, a level rule on the input, the row and
// the business's settings (a threshold, an approver per amount band), who decides (by capability,
// a named person, never the requester), where and how surely, expiry and its sweeper, approved
// replays bounded by what was approved, and undoing a write within its window. The fixture's
// features/approval-levels declares the levels; the framework declares none. Also (H1): approval
// requests reach their deciders by push, WhatsApp only where it can decide, email and the inbox;
// an undoable write's notifications and sends wait for its window, and an undo withdraws them.
// A stand-in push service (EXPO_BASE_URL) and Mailpit.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { capabilitiesOf, type Principal } from '@hykr/contracts';
import {
  ApprovalService,
  CORE_OPTIONS,
  type CoreOptions,
  needsApproval,
  runWrite,
} from '@hykr/core';
import { contentHash } from '@hykr/notifications';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as api from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  seedContact,
  server,
  setTenantSettings,
  shutdown,
  stamp,
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
  await setTenantSettings(tenantId, { approvals });
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

/** What the stand-in push service was asked to send. */
type Pushed = { to: string; title: string; body: string; data: Record<string, string> };
const pushed: Pushed[] = [];
let pushStub: Server;
const OPS_DEVICE = `ExponentPushToken[ops-levels-${stamp}]`;

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  return JSON.parse(
    (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'),
  );
}

/** A person's in-app inbox item for a notification (by its dedupe key), in any business. */
const inboxItem = async (p: Person, dedupe: string) =>
  (
    await pool.query(
      `select tenant_id, notification, title, body, url from channel.inbox_items
       where user_id = $1 and dedupe = $2`,
      [p.id, dedupe],
    )
  ).rows[0] as { notification: string; title: string; body: string; url: string } | undefined;

/** The text of an email with this subject sent to this person (holding `needle`), from Mailpit. */
async function mailText(p: Person, subject: string, needle = ''): Promise<string | undefined> {
  // By address only: the search syntax would take apart a subject that holds a double mark.
  const query = encodeURIComponent(`to:"${p.email}"`);
  const found = (await (
    await fetch(`http://localhost:8025/api/v1/search?query=${query}`)
  ).json()) as {
    messages: { ID: string; Subject: string }[];
  };
  for (const hit of found.messages.filter((m) => m.Subject === subject)) {
    const one = (await (await fetch(`http://localhost:8025/api/v1/message/${hit.ID}`)).json()) as {
      Text: string;
    };
    if (one.Text.includes(needle)) return one.Text;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  pushStub = createServer(async (req, res) => {
    const body = await bodyOf(req);
    const reply = (value: unknown) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url?.endsWith('/push/send')) {
      const messages = body as Pushed[];
      pushed.push(...messages);
      reply({ data: messages.map((_, i) => ({ status: 'ok', id: `rcpt-${stamp}-${i}` })) });
      return;
    }
    if (req.url?.endsWith('/push/getReceipts')) {
      const { ids } = body as { ids: string[] };
      reply({ data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => pushStub.listen(0, r));
  // Read by the push SDK when it first loads (the first registration).
  process.env.EXPO_BASE_URL = `http://localhost:${(pushStub.address() as { port: number }).port}`;
  await boot(approvalLevelsApp);
  for (const p of [owner, ops, admin, staff, lead, outsider, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(ops, tenantId, ['ops']);
  await addMember(admin, tenantId, ['admin']);
  await addMember(staff, tenantId, ['staff']);
  await addMember(lead, tenantId, ['staff']);
});
afterAll(async () => {
  pushStub.close();
  await shutdown();
});

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

  it("a rule that leaves it to the requester: theirs on the team, the business's when they are outside it", async () => {
    const options = server.app?.get(CORE_OPTIONS, { strict: false }) as CoreOptions;
    // A write whose own rule says the requester decides: the assistant asks for this person.
    const op = {
      name: 'fixture.own_say',
      kind: 'command',
      resourceType: 'payment',
      resourceId: () => null,
      input: z.object({}),
      authorize: () =>
        needsApproval('fixture_own_say', 'Asked for this person', {
          approver: { by: 'requester' },
        }),
      summarize: () => 'Something of their own',
      run: async () => ({ value: null, touched: [] }),
      present: (v: unknown) => v,
    } as unknown as Parameters<typeof runWrite>[2];
    const asking = (roles: string[]): Principal => ({
      actor: { kind: 'agent', id: 'assistant' },
      subject: { kind: 'user', userId: staff.id },
      tenantId,
      roles,
      capabilities: capabilitiesOf(roles),
      standing: 'member',
      assurance: 'session',
      channel: 'app',
      scopes: [],
    });
    const park = async (roles: string[]) => {
      const out = await runWrite(
        options.db,
        { principal: asking(roles), requestId: `r-own-${roles.join()}` },
        op,
        {},
      );
      return (out.result as { approval: { decider: unknown; canDecide: boolean } }).approval;
    };
    expect(await park(['staff'])).toMatchObject({
      decider: { by: 'requester', userId: staff.id },
      canDecide: true,
    });
    // Holding only a contact's roles now: outside the team, so the business decides, as it
    // will when the request is looked at or decided.
    expect(await park(['customer'])).toMatchObject({
      decider: { by: 'capability', capability: 'approvals.decide' },
      canDecide: false,
    });
  });

  it('a named approver who leaves after a request parked gives way to the business', async () => {
    const leaver = new Person('Leaver Levels');
    await leaver.signUp();
    await addMember(leaver, tenantId, ['staff']);
    await approvalsSettings({
      thresholds: LIMIT,
      bands: { payments: [{ approver: { userId: leaver.id } }] },
    });
    const res = await pay(owner, 500_00);
    const id = res.body.approval.id;
    expect(res.body.approval.decider).toEqual({ by: 'person', userId: leaver.id });
    expect((await look(ops, id)).status).toBe(404);

    // They leave the business: the holders of approvals.decide decide it now, never the requester.
    await pool.query('delete from app.memberships where tenant_id = $1 and user_id = $2', [
      tenantId,
      leaver.id,
    ]);
    const business = { by: 'capability', capability: 'approvals.decide' };
    expect((await look(ops, id)).body).toMatchObject({ canDecide: true, decider: business });
    const waiting = await ops.call('GET', '/api/approvals', undefined, as(ops));
    expect(waiting.body.map((a: { id: string }) => a.id)).toContain(id);
    expect((await look(owner, id)).body).toMatchObject({ canDecide: false, decider: business });
    expect((await approve(owner, id)).status).toBe(403);
    expect((await approve(ops, id)).body).toMatchObject({ status: 'approved' });

    // Still a member, but holding only an outsider's roles now: off the team too. Back on it,
    // the request is theirs alone again.
    await addMember(leaver, tenantId, ['staff']);
    const again = (await pay(owner, 500_00)).body.approval.id;
    await addMember(leaver, tenantId, ['customer']);
    expect((await look(ops, again)).body).toMatchObject({ canDecide: true, decider: business });
    await addMember(leaver, tenantId, ['staff']);
    expect((await look(ops, again)).status).toBe(404);
    const theirs = await leaver.call(
      'POST',
      `/api/approvals/${again}/approve`,
      undefined,
      inTenant(),
    );
    expect(theirs.body).toMatchObject({ status: 'approved' });
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

describe("a template send at a level keeps its own decision's decider", () => {
  const outbox = async (template: string) =>
    (
      await pool.query(
        'select count(*)::int as n from app.outbox where tenant_id = $1 and key = $2',
        [tenantId, `template:${template}`],
      )
    ).rows[0].n as number;

  it('a service send waits for the person it is for, who approves it; their own runs', async () => {
    await approvalsSettings({});
    const { customerId } = await seedContact(tenantId, 'Customer Levels', `+9198${stamp % 1e8}`);
    const service = { customerId, template: 'task_due_v1', params: { title: 'Pay the deposit' } };
    const before = await outbox('task_due_v1');

    const sent = await asAssistant(`user:${owner.id}`)('POST', '/api/notify/send', service);
    expect(sent.body).toMatchObject({
      status: 'needs_approval',
      approval: {
        rule: 'send_goes_out',
        level: { name: 'fixture_outside' },
        decider: { by: 'requester', userId: owner.id },
      },
    });
    const { id } = sent.body.approval;
    expect((await look(owner, id)).body).toMatchObject({ canDecide: true });
    expect((await look(stranger, id)).status).toBe(404);
    expect((await approve(owner, id)).body).toMatchObject({ status: 'approved' });
    expect(await outbox('task_due_v1')).toBe(before + 1);

    // The person sending it themselves is the human it needs: it runs.
    expect((await owner.call('POST', '/api/notify/send', service)).body).toMatchObject({
      status: 'done',
    });
    expect(await outbox('task_due_v1')).toBe(before + 2);
  });

  it('a marketing send at the same level waits for the holders of marketing.approve', async () => {
    await approvalsSettings({});
    const { customerId } = await seedContact(tenantId, 'Buyer Levels', `+9197${stamp % 1e8}`);
    const sent = await asAssistant(`user:${owner.id}`)('POST', '/api/notify/send', {
      customerId,
      template: 'monthly_update_v1',
      params: { name: 'Asha', news: 'New hours' },
    });
    expect(sent.body).toMatchObject({
      status: 'needs_approval',
      approval: {
        rule: 'marketing_send',
        level: { name: 'fixture_outside' },
        decider: { by: 'capability', capability: 'marketing.approve' },
      },
    });
    const { id } = sent.body.approval;
    // The owner holds marketing.approve, but asked: someone else decides.
    expect(await approve(owner, id)).toMatchObject({ status: 403, body: { rule: 'own_request' } });
    expect((await approve(admin, id)).body).toMatchObject({ status: 'approved' });
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

  it('fails, and is decided, when what was asked no longer validates', async () => {
    await approvalsSettings({ thresholds: LIMIT, levels: { fixture_internal: { parks: true } } });
    const res = await pay(owner, 50_00, { title: 'Scrubbed since' });
    const id = res.body.approval.id;
    // An erasure's scrubbing took a required field out of the stored input.
    await pool.query(
      `update app.approvals set payload = payload #- '{input,title}' where id = $1`,
      [id],
    );
    expect((await approve(owner, id)).body).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('title'),
    });
    expect((await approve(owner, id)).status).toBe(409);
  });

  it('approved twice at the same moment when it no longer validates: failed once, audited once', async () => {
    await approvalsSettings({ thresholds: LIMIT, levels: { fixture_internal: { parks: true } } });
    const res = await pay(owner, 50_00, { title: 'Scrubbed twice' });
    const id = res.body.approval.id;
    await pool.query(
      `update app.approvals set payload = payload #- '{input,title}' where id = $1`,
      [id],
    );
    const both = await Promise.all([approve(owner, id), approve(owner, id)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await audit(id)).filter((a) => a.action === 'approval.failed')).toHaveLength(1);
    const decided = await pool.query(
      `select 1 from app.domain_events where name = 'approval.decided' and resource_id = $1`,
      [id],
    );
    expect(decided.rowCount).toBe(1);
  });

  it('more approvals at once than the pool holds all replay, and nothing else waits', async () => {
    const { sharedDb } = await import('../../dist/infra/db.js');
    const n = 2 * ((sharedDb.pool.options.max as number | undefined) ?? 10) + 2;
    await approvalsSettings({ thresholds: LIMIT, levels: { fixture_internal: { parks: true } } });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await pay(owner, 10_00 + i)).body.approval.id);
    const started = Date.now();
    const all = await Promise.all(ids.map((id) => approve(owner, id)));
    expect(all.map((r) => r.body.status)).toEqual(Array(n).fill('approved'));
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

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

describe('approval requests reach their deciders on every channel (H1)', () => {
  let adminContact = '';
  const waAsks = async (contactId: string, approvalId: string) =>
    (
      await pool.query(
        `select template from channel.messages
         where contact_id = $1 and notification = 'approval.request' and meta->'row'->>'id' = $2`,
        [contactId, approvalId],
      )
    ).rows;

  beforeAll(async () => {
    // WhatsApp could reach the admin: the business has a number, its templates are approved, and
    // the admin's number is linked. The ops member has the app on a phone. The owner has neither.
    expect(
      (await owner.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: `pn-${stamp}` }))
        .status,
    ).toBe(201);
    for (const t of approvalLevelsApp.notifications.templates)
      await pool.query(
        `insert into channel.templates (name, language, category, content_hash, status)
         values ($1, 'en', $2, $3, 'APPROVED')
         on conflict (name, language) do update set status = 'APPROVED'`,
        [t.name, t.category, contentHash(t, 'en')],
      );
    const c = await seedContact(tenantId, 'Admin Levels', `+9196${stamp % 1e8}`);
    await pool.query('update channel.contacts set user_id = $1, linked_at = now() where id = $2', [
      admin.id,
      c.contactId,
    ]);
    adminContact = c.contactId;
    expect(
      (
        await ops.call(
          'POST',
          '/api/push/tokens',
          { token: OPS_DEVICE, platform: 'ios' },
          inTenant(),
        )
      ).status,
    ).toBe(201);
  });

  it('an app-only request: push to a phone, else email, always the inbox; never WhatsApp', async () => {
    await approvalsSettings({});
    const res = await pay(staff, 10_00, { title: `App only ${stamp}` });
    expect(res.body.approval).toMatchObject({
      level: final,
      decider: { by: 'capability', capability: 'approvals.decide' },
    });
    const { id, summary } = res.body.approval;
    const dedupe = `approval.request:${id}`;
    const subject = `Waiting for your approval: ${summary}`;
    // Both holders find it in their inbox, opening the request.
    for (const who of [owner, ops])
      expect(await eventually(() => inboxItem(who, dedupe))).toMatchObject({
        notification: 'approval.request',
        title: 'Waiting for your approval',
        body: summary,
        url: `/approvals/${id}`,
      });
    // The one with a phone gets a push that opens it, and no email.
    const push = await eventually(() =>
      pushed.find((m) => m.to === OPS_DEVICE && m.data.url === `/approvals/${id}`),
    );
    expect(push).toMatchObject({ title: 'Waiting for your approval', body: summary });
    // The one without a phone or WhatsApp gets an email that links to it.
    expect(await eventually(() => mailText(owner, subject, `/approvals/${id}`))).toBeDefined();
    await sleep(1000);
    expect(await mailText(ops, subject, `/approvals/${id}`)).toBeUndefined();
    // Neither the requester nor another business hears of it.
    expect(await inboxItem(staff, dedupe)).toBeUndefined();
    expect(await inboxItem(stranger, dedupe)).toBeUndefined();
  });

  it('a decider whose number is linked gets email, not WhatsApp, for a request decided in the app', async () => {
    await approvalsSettings({
      bands: { payments: [{ approver: { capability: 'fixture.payments.approve' } }] },
    });
    const res = await pay(staff, 10_00, { title: `Band only ${stamp}` });
    expect(res.body.approval.decider).toEqual({
      by: 'capability',
      capability: 'fixture.payments.approve',
    });
    const { id, summary } = res.body.approval;
    expect(await eventually(() => inboxItem(admin, `approval.request:${id}`))).toMatchObject({
      url: `/approvals/${id}`,
    });
    expect(
      await eventually(() =>
        mailText(admin, `Waiting for your approval: ${summary}`, `/approvals/${id}`),
      ),
    ).toBeDefined();
    // Approve and Reject on WhatsApp could not decide it (the app only, signed in): not sent.
    expect(await waAsks(adminContact, id)).toEqual([]);
  });

  it('a request WhatsApp may decide goes there to the linked decider, by email to one without', async () => {
    await approvalsSettings({});
    const { customerId } = await seedContact(tenantId, 'Reader Levels', `+9195${stamp % 1e8}`);
    const sent = await asAssistant(`user:${staff.id}`, inTenant())('POST', '/api/notify/send', {
      customerId,
      template: 'monthly_update_v1',
      params: { name: 'Asha', news: `News ${stamp}` },
    });
    expect(sent.body.approval.decider).toEqual({
      by: 'capability',
      capability: 'marketing.approve',
    });
    const { id, summary } = sent.body.approval;
    // The admin, linked and without a phone: Approve and Reject on WhatsApp.
    expect(await eventually(() => waAsks(adminContact, id).then((r) => r[0]))).toEqual({
      template: 'approval_request_v1',
    });
    // The owner, without WhatsApp: by email, and in the inbox.
    expect(
      await eventually(() =>
        mailText(owner, `Waiting for your approval: ${summary}`, `/approvals/${id}`),
      ),
    ).toBeDefined();
    expect(await eventually(() => inboxItem(owner, `approval.request:${id}`))).toBeDefined();
    expect(await eventually(() => inboxItem(admin, `approval.request:${id}`))).toBeDefined();
  });
});

describe('an undoable write holds what it sends (H1)', () => {
  // A short window, so the tests see it close.
  const SHORT = { thresholds: LIMIT, levels: { fixture_internal: { undoMs: 3000 } } };
  const sends = async (paymentId: string) =>
    (
      await pool.query(
        `select available_at, cancelled_at, relayed_at, undo_id from app.outbox
         where tenant_id = $1 and key = 'fixture.payment-flagged' and payload->'row'->>'id' = $2
         order by id`,
        [tenantId, paymentId],
      )
    ).rows as {
      available_at: Date;
      cancelled_at: Date | null;
      relayed_at: Date | null;
      undo_id: string | null;
    }[];
  const flagged = async (title: string) =>
    (
      await pool.query(
        `select body from channel.inbox_items
         where user_id = $1 and notification = 'fixture.payment-flagged' and title = $2`,
        [owner.id, `Flagged: ${title}`],
      )
    ).rows[0];

  it("a notification on its event waits for the window; an undone write's never arrives", async () => {
    await approvalsSettings(SHORT);
    const undone = await pay(owner, 10_00, { title: `Heard undone ${stamp}` });
    const kept = await pay(owner, 10_00, { title: `Heard kept ${stamp}` });
    expect(kept.body).toMatchObject({ status: 'done', undo: { id: expect.any(String) } });
    expect((await undo(owner, undone.body.undo.id)).status).toBe(200);
    // Held while the window is open.
    await sleep(1000);
    expect(await inboxItem(owner, `fixture.payment-made:${kept.body.value.id}`)).toBeUndefined();
    // Once it closes, the one kept arrives; the one undone never does.
    expect(
      await eventually(
        () => inboxItem(owner, `fixture.payment-made:${kept.body.value.id}`),
        15_000,
      ),
    ).toMatchObject({ title: `Paid: Heard kept ${stamp}` });
    await sleep(1500);
    expect(await inboxItem(owner, `fixture.payment-made:${undone.body.value.id}`)).toBeUndefined();
  });

  it('a send its command writes waits for the window too, and undoing the write withdraws it', async () => {
    await approvalsSettings(SHORT);
    const one = (await pay(owner, 10_00, { title: `Flag undone ${stamp}` })).body.value;
    const two = (await pay(owner, 10_00, { title: `Flag kept ${stamp}` })).body.value;
    const first = await owner.call('POST', `/api/payments/${one.id}/flag`, { note: 'Check it' });
    expect(first.body).toMatchObject({ status: 'done', undo: { id: expect.any(String) } });
    const [held] = await sends(one.id);
    expect(held).toMatchObject({ undo_id: first.body.undo.id, relayed_at: null });
    expect(Math.abs(held.available_at.getTime() - Date.parse(first.body.undo.until))).toBeLessThan(
      1000,
    );
    const second = await owner.call('POST', `/api/payments/${two.id}/flag`, { note: 'Fine' });
    expect(second.body.status).toBe('done');

    expect((await undo(owner, first.body.undo.id)).status).toBe(200);
    expect((await sends(one.id))[0].cancelled_at).not.toBeNull();
    expect((await owner.call('GET', `/api/payments/${one.id}`)).body.note).toBeNull();
    // The one kept goes once its window closes; the one withdrawn never does.
    expect(await eventually(() => flagged(two.title), 15_000)).toBeDefined();
    expect((await sends(two.id))[0].relayed_at).not.toBeNull();
    await sleep(1500);
    expect((await sends(one.id))[0].relayed_at).toBeNull();
    expect(await flagged(one.title)).toBeUndefined();
  });

  it('an undo is refused when a held send was already passed on', async () => {
    await approvalsSettings(SHORT);
    const pay1 = (await pay(owner, 10_00, { title: `Flag passed ${stamp}` })).body.value;
    const flag = await owner.call('POST', `/api/payments/${pay1.id}/flag`, { note: 'Gone out' });
    await pool.query(`update app.outbox set relayed_at = now() where undo_id = $1`, [
      flag.body.undo.id,
    ]);
    expect(await undo(owner, flag.body.undo.id)).toMatchObject({
      status: 409,
      body: { error: 'too_late' },
    });
    expect((await owner.call('GET', `/api/payments/${pay1.id}`)).body.note).toBe('Gone out');
  });
});
