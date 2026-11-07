// The orders module end to end: money in minor units (INR in this business's settings), the
// module's number series, its tax function, a tree of groups and lines saved whole, approval
// by level and limit, cost hidden by capability, cancel instead of delete.

import { addMember, asAssistant, boot, me, Person, pool, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Orders');
const staff = new Person('Staff Orders');
const admin = new Person('Admin Orders');
const stranger = new Person('Stranger Orders');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
type Money = { minor: number; currency: string };
const inr = (minor: number): Money => ({ minor, currency: 'INR' });

type Item = {
  id: string;
  parentItemId: string | null;
  kind: 'group' | 'line';
  title: string;
  amount: Money;
  cost?: Money | null;
};

/** A kitchen and a bathroom, three lines at two tax rates. */
const rooms = [
  { ref: 'k', kind: 'group', title: 'Kitchen' },
  {
    ref: 'k1',
    parent: 'k',
    title: 'Cabinet',
    quantity: 2,
    unitPrice: '1500.00',
    taxRateBp: 1800,
    cost: '1000',
  },
  { ref: 'k2', parent: 'k', title: 'Sink', quantity: 1, unitPrice: '800.50', taxRateBp: 1200 },
  { ref: 'b', kind: 'group', title: 'Bathroom' },
  { ref: 'b1', parent: 'b', title: 'Tiles', quantity: 10, unitPrice: '45.25', taxRateBp: 1800 },
];

const save = (person: Person, body: object, headers: Record<string, string> = {}) =>
  person.call('POST', '/api/orders/save', body, headers);

const numberRe = /^ORD\/\d{4}-\d{2}\/\d{4}$/;

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, staff, admin, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(admin, tenantId, ['admin']);
  // The business counts in INR, its financial year starts in April, and it sets its own
  // approval limit (10,000.00).
  await pool.query(`update app.tenants set settings = settings || $2::jsonb where id = $1`, [
    tenantId,
    JSON.stringify({
      money: { currency: 'INR', fyStartMonth: 4, amounts: { 'orders.approval': inr(1_000_000) } },
    }),
  ]);
});
afterAll(shutdown);

describe('orders, end to end', () => {
  let orderId = '';
  let items: Item[] = [];

  it('saves an order with groups and lines: a number, amounts, tax lines and totals', async () => {
    const res = await save(owner, { title: 'Flat 4B', items: rooms });
    expect(res.status).toBe(200);
    const { order } = res.body.value;
    items = res.body.value.items;
    orderId = order.id;
    expect(order.number).toMatch(numberRe);
    expect(order).toMatchObject({ currency: 'INR', status: 'open', lineCount: 3 });
    // Lines: 2 × 1500.00, 1 × 800.50, 10 × 45.25; groups add their lines up.
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(byTitle.Cabinet.amount).toEqual(inr(300_000));
    expect(byTitle.Kitchen.amount).toEqual(inr(380_050));
    expect(byTitle.Bathroom.amount).toEqual(inr(45_250));
    expect(order.subtotal).toEqual(inr(425_300));
    // 18% of 3000.00 + 452.50 and 12% of 800.50, each rounded once.
    expect(order.taxLines).toEqual([
      expect.objectContaining({ code: 'tax.1200', basis: inr(80_050), amount: inr(9_606) }),
      expect.objectContaining({ code: 'tax.1800', basis: inr(345_250), amount: inr(62_145) }),
    ]);
    expect(order.taxTotal).toEqual(inr(71_751));
    expect(order.total).toEqual(inr(497_051));
  });

  it("numbers the business's orders one after another", async () => {
    const next = await save(owner, { title: 'Flat 4C', items: [] });
    const seq = (n: string) => Number(n.split('/').at(-1));
    const first = (await owner.call('GET', `/api/orders/${orderId}`)).body.number;
    expect(seq(next.body.value.order.number)).toBe(seq(first) + 1);
    expect(next.body.value.order.number.split('/')[1]).toBe(first.split('/')[1]);
  });

  it("reads the items back as the order's tree", async () => {
    const read: (Item & { position: number })[] = (
      await owner.call('GET', `/api/orderItems?orderId=${orderId}`)
    ).body.items;
    const under = (id: string | null) =>
      read
        .filter((i) => i.parentItemId === id)
        .sort((a, b) => a.position - b.position)
        .map((i) => i.title);
    expect(under(null)).toEqual(['Kitchen', 'Bathroom']);
    const kitchen = read.find((i) => i.title === 'Kitchen') as Item;
    expect(under(kitchen.id)).toEqual(['Cabinet', 'Sink']);
  });

  it('changes an order whole: keeps, edits, removes and adds items, keeping its number', async () => {
    const before = (await owner.call('GET', `/api/orders/${orderId}`)).body;
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    const res = await save(owner, {
      orderId,
      title: 'Flat 4B, revised',
      items: [
        { ref: 'k', id: byTitle.Kitchen.id, kind: 'group', title: 'Kitchen' },
        {
          ref: 'k1',
          id: byTitle.Cabinet.id,
          parent: 'k',
          title: 'Cabinet',
          quantity: 3,
          unitPrice: '1500.00',
          taxRateBp: 1800,
        },
        { ref: 'k3', parent: 'k', title: 'Chimney', unitPrice: '999', taxRateBp: 1800 },
      ],
    });
    expect(res.status).toBe(200);
    const order = res.body.value.order;
    expect(order.number).toBe(before.number);
    expect(order.lineCount).toBe(2);
    expect(order.subtotal).toEqual(inr(549_900));
    const titles = res.body.value.items.map((i: Item) => i.title);
    expect(titles).toEqual(['Kitchen', 'Cabinet', 'Chimney']);
  });

  it('refuses a line under a line, a line without a price, and too many decimals', async () => {
    const underLine = await save(owner, {
      title: 'Bad',
      items: [
        { ref: 'a', title: 'A', unitPrice: '1' },
        { ref: 'b', parent: 'a', title: 'B', unitPrice: '1' },
      ],
    });
    expect(underLine.status).toBe(403);
    expect(underLine.body.rule).toBe('order_items_invalid');
    const noPrice = await save(owner, { title: 'Bad', items: [{ ref: 'a', title: 'A' }] });
    expect(noPrice.body.rule).toBe('order_items_invalid');
    const fine = await save(owner, {
      title: 'Bad',
      items: [{ ref: 'a', title: 'A', unitPrice: '1.005' }],
    });
    expect(fine.body.rule).toBe('money_invalid');
  });

  it('another business gets 404 for the order, its items and a save on it', async () => {
    expect((await stranger.call('GET', `/api/orders/${orderId}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/orderItems/${items[0].id}`)).status).toBe(404);
    const theirs = await stranger.call('GET', `/api/orderItems?orderId=${orderId}`);
    expect(theirs.body.items).toEqual([]);
    expect((await save(stranger, { orderId, title: 'Mine', items: [] })).status).toBe(404);
  });

  it('is never deleted or written by plain CRUD: it is cancelled, and its number stays', async () => {
    expect((await owner.call('DELETE', `/api/orders/${orderId}`)).status).toBe(404);
    expect((await owner.call('POST', '/api/orders', { title: 'Direct' })).status).toBe(404);
    expect((await owner.call('POST', '/api/orderItems', { title: 'Loose' })).status).toBe(404);
    const cancelled = await owner.call('POST', `/api/orders/${orderId}/cancel`, {});
    expect(cancelled.body).toMatchObject({ status: 'done' });
    expect(cancelled.body.value).toMatchObject({ status: 'cancelled' });
    const again = await owner.call('POST', `/api/orders/${orderId}/cancel`, {});
    expect(again.body.rule).toBe('order_cancelled');
    const edit = await save(owner, { orderId, title: 'Revived', items: [] });
    expect(edit.body.rule).toBe('order_cancelled');
  });
});

describe('who decides, and who sees the cost', () => {
  it("the assistant's save waits for the person; the number is taken only when it runs", async () => {
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', '/api/orders/save', { title: 'Asked', items: rooms });
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval).toMatchObject({ amount: inr(497_051) });
    expect(parked.body.approval.summary).toContain('5 items');
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
    const { rows } = await pool.query(
      'select number from app.orders where tenant_id = $1 and title = $2',
      [tenantId, 'Asked'],
    );
    expect(rows[0].number).toMatch(numberRe);
  });

  it('staff above the limit wait for an owner, in the app; the owner may save it directly', async () => {
    const big = [{ ref: 'a', title: 'Marble', quantity: 100, unitPrice: '500' }];
    const parked = await save(staff, { title: 'Big', items: big }, inTenant());
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval).toMatchObject({
      level: { name: 'irreversible' },
      amount: inr(5_000_000),
      rule: 'order_over_limit',
    });
    // Staff may open their own request, never decide it; the owner can.
    const seen = await staff.call(
      'GET',
      `/api/approvals/${parked.body.approval.id}`,
      undefined,
      inTenant(),
    );
    expect(seen.body).toMatchObject({
      canDecide: false,
      decider: { by: 'capability', capability: 'orders.approve' },
    });
    const byStaff = await staff.call(
      'POST',
      `/api/approvals/${parked.body.approval.id}/approve`,
      undefined,
      inTenant(),
    );
    expect(byStaff.status).toBe(403);
    expect(byStaff.body.rule).toBe('own_request');
    const byOwner = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(byOwner.body.status).toBe('approved');
    // The owner holds orders.approve: the same order saves at once.
    const direct = await save(owner, { title: 'Big too', items: big });
    expect(direct.body.status).toBe('done');
  });

  it("the owner's assistant above the limit waits for the owner, at the same level", async () => {
    const big = [{ ref: 'a', title: 'Granite', quantity: 100, unitPrice: '500' }];
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', '/api/orders/save', { title: 'Asked big', items: big });
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval).toMatchObject({
      level: { name: 'irreversible' },
      rule: 'order_over_limit',
      decider: { by: 'requester', userId: owner.id },
    });
    // The park is audited with its level.
    const audit = await pool.query(
      `select outcome, rule, after from audit.events where after->>'approvalId' = $1`,
      [parked.body.approval.id],
    );
    expect(audit.rows[0]).toMatchObject({
      outcome: 'needs_approval',
      rule: 'order_over_limit',
      after: { level: 'irreversible' },
    });
    // Another business never sees it.
    const id = parked.body.approval.id;
    expect((await stranger.call('GET', `/api/approvals/${id}`)).status).toBe(404);
    expect((await stranger.call('POST', `/api/approvals/${id}/approve`)).status).toBe(404);
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
  });

  it('a line cost is hidden from staff, in the save result, the items and the approval card', async () => {
    const res = await save(staff, { title: 'Staff order', items: rooms }, inTenant());
    expect(res.status).toBe(200);
    for (const i of res.body.value.items) expect(i).not.toHaveProperty('cost');
    const read = await staff.call(
      'GET',
      `/api/orderItems?orderId=${res.body.value.order.id}`,
      undefined,
      inTenant(),
    );
    expect(read.body.items).toHaveLength(5);
    for (const i of read.body.items) expect(i).not.toHaveProperty('cost');
    const asks = asAssistant(`user:${staff.id}`, { 'x-channel': 'app', 'x-tenant-id': tenantId });
    const parked = await asks('POST', '/api/orders/save', { title: 'Staff asked', items: rooms });
    const card = await staff.call(
      'GET',
      `/api/approvals/${parked.body.approval.id}`,
      undefined,
      inTenant(),
    );
    for (const i of card.body.input.items) expect(i).not.toHaveProperty('cost');
    // An admin reaches the whole business, and holds orders.cost.read.
    const seen = await admin.call(
      'GET',
      `/api/orderItems?orderId=${res.body.value.order.id}`,
      undefined,
      inTenant(),
    );
    expect(seen.body.items.find((i: Item) => i.title === 'Cabinet').cost).toEqual(inr(100_000));
  });

  it('a 200-line order is saved, parked and approved as one', async () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, g) => ({
        ref: `g${g}`,
        kind: 'group',
        title: `Room ${g}`,
      })),
      ...Array.from({ length: 200 }, (_, i) => ({
        ref: `l${i}`,
        parent: `g${i % 10}`,
        title: `Item ${i}`,
        quantity: 1,
        unitPrice: '10.00',
        taxRateBp: 500,
      })),
    ];
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', '/api/orders/save', { title: 'Two hundred', items: lines });
    expect(parked.body.status).toBe('needs_approval');
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
    const order = (
      await pool.query(
        'select id, total, line_count from app.orders where tenant_id = $1 and title = $2',
        [tenantId, 'Two hundred'],
      )
    ).rows[0];
    expect(order).toMatchObject({ total: '210000', line_count: 200 });
    const read = await owner.call('GET', `/api/orderItems?orderId=${order.id}&limit=1000`);
    expect(read.body.items).toHaveLength(210);
  });

  it('through chat: the scripted assistant saves an order and asks for approval', async () => {
    const res = await owner.chat('order Hall: 2 Lamp at 1200, 1 Rug at 3000 +12%');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/approv/i);
    // A cancel finds the order by its number first, and waits for approval too.
    const saved = await save(owner, { title: 'To cancel', items: [] });
    const number = saved.body.value.order.number;
    const cancel = await owner.chat(`cancel order ${number}`);
    expect(JSON.stringify(cancel.body)).toMatch(/approv/i);
    const { rows } = await pool.query(
      "select status from app.approvals where action = 'order.cancel' and resource_id = $1",
      [saved.body.value.order.id],
    );
    expect(rows).toEqual([{ status: 'pending' }]);
  });
});
