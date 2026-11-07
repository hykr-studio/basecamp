// The orders module's acceptance (OrderAcceptance, B8): an order its customer asked for is
// submitted and approved, its PDF made, and the customer accepts exactly that PDF with a one-time
// code to their email. The order is then `accepted` and frozen (no save, no revise), and its
// evidence holds the PDF's hash and the order's version. Nobody outside the business reaches it.
import {
  addMember,
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

async function mails(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const { messages } = (await res.json()) as { messages: { ID: string; Subject: string }[] };
  return messages.filter((m) => /verification code/.test(m.Subject)).map((m) => m.ID);
}

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, customer, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
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
    expect((await move(owner, order.id, 'approve')).status).toBe(200);
    const asked = await owner.call('POST', '/api/documents', {
      document: 'orders.order',
      id: order.id,
    });
    expect(asked.status).toBe(200);
    doc = await eventually(async () => {
      const got = await owner.call('GET', `/api/documents/${asked.body.value.id}`);
      return got.body?.status === 'ready' ? got.body : undefined;
    });
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
    // Only the customer accepts.
    const notTheirs = await staff.call(
      'GET',
      `/api/acceptances/documents/${doc.id}`,
      undefined,
      inTenant(),
    );
    expect(notTheirs.body.can).toMatchObject({ ok: false });
  });

  it('the customer accepts with the code emailed to them; the order is accepted and frozen', async () => {
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
    const now = (await owner.call('GET', `/api/orders/${order.id}`)).body;
    expect(now.status).toBe('accepted');
    // The contract: no save, no revision.
    const save = await owner.call('POST', '/api/orders/save', {
      orderId: order.id,
      title: 'Changed',
      items,
    });
    expect(save.status).toBeGreaterThanOrEqual(400);
    const revise = await owner.call('POST', `/api/orders/${order.id}/revise`, {});
    expect(revise.status).toBe(403);
    expect(revise.body.rule).toBe('order_revise_submitted');
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
  });
});
