// The orders module's acceptance (OrderAcceptance, B8 and H5): an order its customer asked for is
// submitted and approved, its PDF made, and the customer accepts exactly that PDF with a one-time
// code to their email. The order moves to `accepted` in the same write, frozen (no save, no
// revise); its evidence holds the PDF's hash and the order's version then. The PDF is accepted once, and no later PDF of it either. A submitted order
// cannot be accepted. Nobody outside the business reaches it.
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  setTenantSettings,
  shutdown,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Order Accept');
const customer = new Person('Customer Order Accept');
const ops = new Person('Ops Order Accept');
const staff = new Person('Staff Order Accept');
const stranger = new Person('Stranger Order Accept');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const items = [
  { ref: 'k', kind: 'group', title: 'Kitchen' },
  { ref: 'k1', parent: 'k', title: 'Cabinet', quantity: 2, unitPrice: '1500.00', taxRateBp: 1800 },
];

const move = (p: Person, id: string, name: string, headers: Record<string, string> = {}) =>
  p.call('POST', `/api/transitions/orders/${id}/${name}`, {}, headers);

/** A PDF of the order, made (the owner asks for it). */
async function pdf(id: string) {
  const asked = await owner.call('POST', '/api/documents', { document: 'orders.order', id });
  expect(asked.status).toBe(200);
  return eventually(async () => {
    const got = await owner.call('GET', `/api/documents/${asked.body.value.id}`);
    return got.body?.status === 'ready' ? (got.body as Json) : undefined;
  });
}

async function mails(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const { messages } = (await res.json()) as { messages: { ID: string; Subject: string }[] };
  return messages.filter((m) => /verification code/.test(m.Subject)).map((m) => m.ID);
}

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, customer, ops, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(ops, tenantId, ['ops']);
  await addMember(staff, tenantId, ['staff']);
  await setTenantSettings(tenantId, { money: { currency: 'INR', fyStartMonth: 4 } });
  // The customer has an account and is this business's customer.
  const { rows } = await pool.query(
    `insert into app.customers (tenant_id, display_name, user_id) values ($1, $2, $3) returning id`,
    [tenantId, customer.name, customer.id],
  );
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, customer_id, is_default)
     values ($1, $2, $3, $4, false)`,
    [tenantId, customer.id, ['customer'], rows[0].id],
  );
});
afterAll(shutdown);

describe("an order's acceptance by its customer", () => {
  let order: Json;
  let doc: Json;
  let accepted: Json;

  it('is offered once the order is approved and its PDF is made', async () => {
    const saved = await customer.call(
      'POST',
      '/api/orders/save',
      { title: 'Flat 9C', items },
      inTenant(),
    );
    expect(saved.status).toBe(200);
    order = saved.body.value.order;
    expect((await move(customer, order.id, 'submit', inTenant())).status).toBe(200);
    // Submitted, not approved: its PDF is not for accepting yet.
    const early = await pdf(order.id);
    const notYet = await customer.call(
      'GET',
      `/api/acceptances/documents/${early.id}`,
      undefined,
      inTenant(),
    );
    expect(notYet.body.can).toMatchObject({ ok: false, rule: 'order_not_approved' });
    expect((await move(owner, order.id, 'approve')).status).toBe(200);
    // Nobody asks for the move to accepted: only the customer's acceptance makes it.
    const accept = await move(owner, order.id, 'accept');
    expect(accept.status).toBe(403);
    expect(accept.body.rule).toBe('system_only');
    doc = await pdf(order.id);
    const status = await customer.call(
      'GET',
      `/api/acceptances/documents/${doc.id}`,
      undefined,
      inTenant(),
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ acceptance: 'orders.order', can: { ok: true } });
    expect(status.body.statement).toMatch(
      new RegExp(
        `^I accept order ${order.number.replaceAll('/', '\\/')}, "Flat 9C", for .+, as shown in this PDF\\.$`,
      ),
    );
    // Only the customer accepts: a colleague who reaches the order may not, and staff (who
    // reach their own orders only) do not reach it at all.
    const notTheirs = await ops.call(
      'GET',
      `/api/acceptances/documents/${doc.id}`,
      undefined,
      inTenant(),
    );
    expect(notTheirs.status).toBe(200);
    expect(notTheirs.body.can).toMatchObject({ ok: false, rule: 'not_signer' });
    const asks = await ops.call(
      'POST',
      '/api/acceptances/challenges',
      { documentId: doc.id },
      inTenant(),
    );
    expect(asks.status).toBe(403);
    expect(asks.body.rule).toBe('not_signer');
    const unreached = await staff.call(
      'GET',
      `/api/acceptances/documents/${doc.id}`,
      undefined,
      inTenant(),
    );
    expect(unreached.status).toBe(404);
  });

  it('the customer accepts with the code emailed to them; the order moves to accepted, frozen', async () => {
    const before = new Set(await mails(customer.email));
    const asked = await customer.call(
      'POST',
      '/api/acceptances/challenges',
      { documentId: doc.id },
      inTenant(),
    );
    expect(asked.status).toBe(200);
    expect(asked.body.value.channel).toBe('email');
    const code = await eventually(async () => {
      const fresh = (await mails(customer.email)).find((id) => !before.has(id));
      if (!fresh) return undefined;
      const body = (await (
        await fetch(`http://localhost:8025/api/v1/message/${fresh}`)
      ).json()) as {
        Text: string;
      };
      return /(\d{6}) is your verification code/.exec(body.Text)?.[1];
    });
    const res = await customer.call(
      'POST',
      '/api/acceptances',
      { challengeId: asked.body.value.id, code },
      inTenant(),
    );
    expect(res.status).toBe(200);
    accepted = res.body.value;
    expect(accepted).toMatchObject({
      acceptance: 'orders.order',
      record: { entity: 'order', id: order.id, version: doc.recordVersion },
      document: { id: doc.id, sha256: doc.sha256 },
      signer: { userId: customer.id },
    });
    // The acceptance's transition: the approved order the customer accepted is now accepted,
    // one write on from the PDF's version (the evidence keeps the version that was accepted).
    const now = (await owner.call('GET', `/api/orders/${order.id}`)).body;
    expect(now.status).toBe('accepted');
    expect(now.version).toBe(doc.recordVersion + 1);
    // The contract: no save, no revision.
    const save = await owner.call('POST', '/api/orders/save', {
      orderId: order.id,
      title: 'Changed',
      items,
    });
    expect(save.status).toBe(403);
    expect(save.body.rule).toBe('record_frozen');
    const revise = await owner.call('POST', `/api/orders/${order.id}/revise`, {});
    expect(revise.status).toBe(403);
    expect(revise.body.rule).toBe('order_revise_submitted');
    // The write stored the move's event with the acceptance.
    const { rows: stored } = await pool.query(
      `select name, actor_kind, actor_id from app.domain_events
        where resource_id = $1 and name = 'order.accept'`,
      [order.id],
    );
    expect(stored).toEqual([{ name: 'order.accept', actor_kind: 'user', actor_id: customer.id }]);
    // The history shows the order's move, by the customer who accepted it.
    const { rows: audited } = await pool.query(
      `select action, outcome, actor_id, before->>'status' as before, after->>'status' as after
         from audit.events where resource_id = $1 and action = 'order.update' order by at desc
         limit 1`,
      [order.id],
    );
    expect(audited[0]).toEqual({
      action: 'order.update',
      outcome: 'committed',
      actor_id: customer.id,
      before: 'approved',
      after: 'accepted',
    });
    // Once: the customer has accepted this PDF.
    const again = await customer.call(
      'GET',
      `/api/acceptances/documents/${doc.id}`,
      undefined,
      inTenant(),
    );
    expect(again.body.can).toMatchObject({ ok: false, rule: 'already_accepted' });
    const asksAgain = await customer.call(
      'POST',
      '/api/acceptances/challenges',
      { documentId: doc.id },
      inTenant(),
    );
    expect(asksAgain.status).toBe(403);
    expect(asksAgain.body.rule).toBe('already_accepted');
    // Nor any later PDF of it: an accepted order is accepted once.
    const later = await pdf(order.id);
    expect(later.recordVersion).toBe(doc.recordVersion + 1);
    const status = await customer.call(
      'GET',
      `/api/acceptances/documents/${later.id}`,
      undefined,
      inTenant(),
    );
    expect(status.body.can).toMatchObject({ ok: false, rule: 'order_accepted' });
    const asksLater = await customer.call(
      'POST',
      '/api/acceptances/challenges',
      { documentId: later.id },
      inTenant(),
    );
    expect(asksLater.status).toBe(403);
    expect(asksLater.body.rule).toBe('order_accepted');
  });

  it('the business keeps the evidence; another business reaches none of it', async () => {
    const full = await owner.call('GET', `/api/acceptances/${accepted.id}`);
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({
      verified: true,
      otp: { channel: 'email', address: customer.email },
      client: { ip: expect.any(String) },
    });
    expect((await stranger.call('GET', `/api/acceptances/${accepted.id}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/acceptances/documents/${doc.id}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/orders/${order.id}`)).status).toBe(404);
  });

  it('the business may still cancel an accepted order; the assistant may not fulfil one', async () => {
    const fulfil = await asAssistant(`user:${owner.id}`)(
      'POST',
      `/api/transitions/orders/${order.id}/fulfil`,
      {},
    );
    expect(fulfil.status).toBe(403);
    expect(fulfil.body.rule).toBe('humans_only');
    const cancelled = await owner.call('POST', `/api/transitions/orders/${order.id}/cancel`, {
      cancelReason: 'The customer moved',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.value).toMatchObject({ status: 'cancelled' });
  });
});
