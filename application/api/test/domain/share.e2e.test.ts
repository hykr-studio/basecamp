// The sample's share links (B9): an approved order shared by link with its customer, behind a
// code to their WhatsApp number. Through the link they see the order and its lines (never what
// the lines cost), open its PDF and accept it with the acceptance's own code, as the order's
// customer (OrderShare, OrderAcceptance): the order moves to accepted, frozen, and the link shows
// it so (H5). And the brief form (briefs.brief): its link asks the brief's questions, and each
// answer is a brief, owned by the business, for a new customer.
import {
  addMember,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  type Res,
  server,
  setTenantSettings,
  shutdown,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Share Sample');
const customer = new Person('Customer Share Sample');
const staff = new Person('Staff Share Sample');
let tenantId = '';
let customerId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
const phone = `9199${String(Date.now()).slice(-8)}`;

/** What someone holding a link has: no session at all. */
async function guest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** The newest verification code sent to this number after `ask` ran. */
async function codeAfter<T>(ask: () => Promise<T>) {
  const count = async () =>
    Number(
      (
        await pool.query(
          `select count(*) from channel.messages where template = 'verification_code_v1' and body->>'to' = $1`,
          [phone],
        )
      ).rows[0].count,
    );
  const before = await count();
  const asked = await ask();
  const code = await eventually(async () => {
    if ((await count()) <= before) return undefined;
    const { rows } = await pool.query(
      `select body from channel.messages where template = 'verification_code_v1' and body->>'to' = $1
       order by at desc limit 1`,
      [phone],
    );
    return rows[0]?.body?.params?.code as string | undefined;
  });
  return { asked, code: code ?? '' };
}

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, customer, staff]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await setTenantSettings(tenantId, { money: { currency: 'INR', fyStartMonth: 4 } });
  // The customer has an account here, and the business also reaches them on WhatsApp.
  const { rows } = await pool.query(
    `insert into app.customers (tenant_id, display_name, user_id) values ($1, $2, $3) returning id`,
    [tenantId, customer.name, customer.id],
  );
  customerId = rows[0].id;
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, customer_id, is_default)
     values ($1, $2, $3, $4, false)`,
    [tenantId, customer.id, ['customer'], customerId],
  );
  const contact = await pool.query(
    `insert into channel.contacts (tenant_id, address, profile_name, customer_id)
     values ($1, $2, $3, $4) returning id`,
    [tenantId, phone, customer.name, customerId],
  );
  await pool.query('update app.customers set contact_id = $1 where id = $2', [
    contact.rows[0].id,
    customerId,
  ]);
});
afterAll(shutdown);

describe('an order shared with its customer', () => {
  let order: Json;
  let doc: Json;
  let link: Json;
  let session = '';

  it('is shared by link, with a code to the customer’s WhatsApp number', async () => {
    const saved = await customer.call(
      'POST',
      '/api/orders/save',
      {
        title: 'Flat 4B',
        items: [
          { ref: 'k', kind: 'group', title: 'Kitchen' },
          {
            ref: 'k1',
            parent: 'k',
            title: 'Cabinet',
            quantity: 2,
            unitPrice: '1500.00',
            taxRateBp: 1800,
          },
        ],
      },
      inTenant(),
    );
    expect(saved.status).toBe(200);
    order = saved.body.value.order;
    // The business sets what a line costs it: only it reads that.
    const items = saved.body.value.items as Json[];
    const costed = await owner.call('POST', '/api/orders/save', {
      orderId: order.id,
      version: order.version,
      title: 'Flat 4B',
      items: items.map((i) => ({
        ref: i.id,
        id: i.id,
        ...(i.parentItemId ? { parent: i.parentItemId } : {}),
        kind: i.kind,
        title: i.title,
        ...(i.kind === 'line'
          ? { quantity: i.quantity, unitPrice: '1500.00', taxRateBp: 1800, cost: '900.00' }
          : {}),
      })),
    });
    expect(costed.status).toBe(200);
    order = costed.body.value.order;
    expect(
      (await customer.call('POST', `/api/transitions/orders/${order.id}/submit`, {}, inTenant()))
        .status,
    ).toBe(200);
    expect(
      (await owner.call('POST', `/api/transitions/orders/${order.id}/approve`, {})).status,
    ).toBe(200);
    const asked = await owner.call('POST', '/api/documents', {
      document: 'orders.order',
      id: order.id,
    });
    doc = await eventually(async () => {
      const got = await owner.call('GET', `/api/documents/${asked.body.value.id}`);
      return got.body?.status === 'ready' ? (got.body as Json) : undefined;
    });
    // Staff do not reach this order: they cannot share it.
    expect(
      (
        await staff.call(
          'POST',
          '/api/shares',
          { target: { entity: 'order', id: order.id } },
          inTenant(),
        )
      ).status,
    ).toBe(404);
    const made = await owner.call('POST', '/api/shares', {
      target: { entity: 'order', id: order.id },
      to: { recordCustomer: true },
      otp: 'whatsapp',
      label: 'Your order',
    });
    expect(made.status).toBe(201);
    link = made.body.value;
    expect(link).toMatchObject({
      otp: { channel: 'whatsapp', sentTo: `•••• ${phone.slice(-4)}` },
      to: { customerId },
    });
  });

  it('opens with the code, and shows the order and its lines without their cost', async () => {
    const gate = await guest('GET', `/api/share/${link.token}`);
    expect(gate.body.record).toBeUndefined();
    expect(gate.body.gate).toMatchObject({ channel: 'whatsapp', verified: false });
    const { asked, code } = await codeAfter(() =>
      guest('POST', `/api/share/${link.token}/code`, { lang: 'hi' }),
    );
    const opened = await guest('POST', `/api/share/${link.token}/verify`, {
      challengeId: asked.body.value.id,
      code,
    });
    expect(opened.status).toBe(200);
    session = opened.body.value.session;
    const res = await guest('GET', `/api/share/${link.token}`, undefined, {
      'x-share-session': session,
    });
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({
      entity: 'order',
      view: 'order.card',
      value: { id: order.id, number: order.number, status: 'approved' },
      documents: [{ id: doc.id, document: 'orders.order', acceptable: true }],
    });
    const lines = res.body.record.children.find((c: Json) => c.entity === 'orderItem');
    expect(lines.items.map((i: Json) => i.title)).toEqual(['Kitchen', 'Cabinet']);
    for (const i of lines.items) expect(i).not.toHaveProperty('cost');
    // The owner reads the cost.
    const own = await owner.call('GET', `/api/orderItems?orderId=${order.id}`);
    expect(own.body.items.find((i: Json) => i.title === 'Cabinet').cost).toMatchObject({
      minor: 90000,
      currency: 'INR',
    });
  });

  it('opens the PDF and accepts it as the order’s customer; the order is accepted, frozen', async () => {
    const h = { 'x-share-session': session };
    const pdf = await guest('GET', `/api/share/${link.token}/documents/${doc.id}`, undefined, h);
    expect(pdf.status).toBe(200);
    expect(typeof pdf.body.url).toBe('string');
    const status = await guest(
      'GET',
      `/api/share/${link.token}/acceptances/documents/${doc.id}`,
      undefined,
      h,
    );
    expect(status.body).toMatchObject({ acceptance: 'orders.order', can: { ok: true } });
    const { asked, code } = await codeAfter(() =>
      guest('POST', `/api/share/${link.token}/acceptances/challenges`, { documentId: doc.id }, h),
    );
    expect(asked.status).toBe(200);
    const done = await guest(
      'POST',
      `/api/share/${link.token}/acceptances`,
      { challengeId: asked.body.value.id, code },
      h,
    );
    expect(done.status).toBe(200);
    expect(done.body.value).toMatchObject({
      acceptance: 'orders.order',
      record: { entity: 'order', id: order.id },
      signer: { kind: 'contact', customerId },
    });
    // The customer, signed in, sees it accepted.
    const again = await customer.call(
      'GET',
      `/api/acceptances/documents/${doc.id}`,
      undefined,
      inTenant(),
    );
    expect(again.body.accepted).toHaveLength(1);
    // The order moved with the acceptance: accepted, one write on, and frozen.
    const now = (await owner.call('GET', `/api/orders/${order.id}`)).body;
    expect(now).toMatchObject({ status: 'accepted', version: doc.recordVersion + 1 });
    const save = await owner.call('POST', '/api/orders/save', {
      orderId: order.id,
      title: 'Changed after acceptance',
      items: [],
    });
    expect(save.status).toBe(403);
    expect(save.body.rule).toBe('record_frozen');
    // The link shows it accepted, and its PDF is not accepted again.
    const shown = await guest('GET', `/api/share/${link.token}`, undefined, h);
    expect(shown.body.record.value).toMatchObject({ id: order.id, status: 'accepted' });
    const once = await guest(
      'GET',
      `/api/share/${link.token}/acceptances/documents/${doc.id}`,
      undefined,
      h,
    );
    expect(once.body.can).toMatchObject({ ok: false, rule: 'already_accepted' });
  });
});

describe('the brief form', () => {
  it('asks the brief’s questions, and an answer is a brief for a new customer', async () => {
    const made = await owner.call('POST', '/api/shares', { target: { form: 'briefs.brief' } });
    expect(made.status).toBe(201);
    const link = made.body.value;
    const res = await guest('GET', `/api/share/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.form).toMatchObject({ name: 'briefs.brief', entity: 'brief', currency: 'INR' });
    expect(res.body.form.fields.map((f: Json) => [f.key, f.type, f.required])).toEqual([
      ['name', 'text', true],
      ['phone', 'text', false],
      ['summary', 'longText', true],
      ['budget', 'money', false],
      ['neededBy', 'date', false],
      ['notes', 'longText', false],
    ]);
    const answered = await guest('POST', `/api/share/${link.token}/submit`, {
      values: {
        name: 'Meera',
        summary: 'Shelves for a study',
        budget: '25000.00',
        neededBy: '2027-01-15',
        status: 'reviewed',
      },
    });
    expect(answered.status).toBe(201);
    const id = answered.body.value.id;
    const brief = (await owner.call('GET', `/api/briefs/${id}`)).body;
    expect(brief).toMatchObject({
      name: 'Meera',
      summary: 'Shelves for a study',
      budget: { minor: 2_500_000, currency: 'INR' },
      neededBy: '2027-01-15',
      status: 'new',
      source: 'form',
    });
    const { rows } = await pool.query(
      `select b.owner_id, c.display_name from app.briefs b join app.customers c on c.id = b.customer_id
       where b.id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ owner_id: owner.id, display_name: 'Meera' });
    // Staff reach their own briefs only; the business's owner reads it in their list.
    expect((await staff.call('GET', `/api/briefs/${id}`, undefined, inTenant())).status).toBe(404);
    expect(
      ((await owner.call('GET', '/api/briefs?source=form')).body.items as Json[]).map((b) => b.id),
    ).toContain(id);
    // A date Postgres cannot store is the guest's mistake, not a 500 (docs/decisions/V10.md).
    const unstorable = await guest('POST', `/api/share/${link.token}/submit`, {
      values: { name: 'Meera', summary: 'Shelves for a study', neededBy: '0000-01-01' },
    });
    expect(unstorable.status).toBe(400);
  });
});
