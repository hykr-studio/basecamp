// The orders module end to end: money in minor units (INR in this business's settings), the
// module's number series, its tax function, a tree of groups and lines saved whole, approval
// by level and limit, cost hidden by capability, cancel instead of delete; its state machine
// (draft → submitted → approved → fulfilled), SLAs on submitted, versions, and revisions.

import { SlaService } from '@hykr/api';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '@hykr/api/testing';
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

const move = (person: Person, id: string, name: string, body = {}, headers = {}) =>
  person.call('POST', `/api/transitions/orders/${id}/${name}`, body, headers);

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
    expect(order).toMatchObject({
      currency: 'INR',
      status: 'draft',
      lineCount: 3,
      version: 1,
      revision: 1,
      seriesId: null,
    });
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
    const cancelled = await move(owner, orderId, 'cancel', { cancelReason: 'Changed plans' });
    expect(cancelled.body).toMatchObject({ status: 'done' });
    expect(cancelled.body.value).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Changed plans',
    });
    const again = await move(owner, orderId, 'cancel');
    expect(again.body.rule).toBe('not_from_state');
    const edit = await save(owner, { orderId, title: 'Revived', items: [] });
    expect(edit.body.rule).toBe('record_frozen');
  });
});

describe("an order's life", () => {
  let orderId = '';
  let number = '';

  it('a save sent with an old version is refused (409)', async () => {
    const first = await save(owner, { title: 'Versioned', items: rooms });
    orderId = first.body.value.order.id;
    number = first.body.value.order.number;
    const second = await save(owner, { orderId, version: 1, title: 'Versioned', items: [] });
    expect(second.body.value.order.version).toBe(2);
    const stale = await save(owner, {
      orderId,
      version: 1,
      title: 'From an old screen',
      items: [],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale');
    // Back to the full order, from the version read.
    const items = (await save(owner, { orderId, version: 2, title: 'Versioned', items: rooms }))
      .body.value;
    expect(items.order.version).toBe(3);
  });

  it('submitting freezes it and starts its SLAs', async () => {
    const submitted = await move(owner, orderId, 'submit');
    expect(submitted.body.value).toMatchObject({ status: 'submitted', version: 4 });
    const edit = await save(owner, { orderId, title: 'Too late', items: [] });
    expect(edit.status).toBe(403);
    expect(edit.body).toMatchObject({ rule: 'record_frozen' });
    expect(edit.body.reason).toContain('Revise it');
    const clocks = (await owner.call('GET', `/api/sla/orders/${orderId}`)).body;
    expect(clocks.map((c: { sla: string }) => c.sla).sort()).toEqual([
      'orders.decision',
      'orders.expiry',
    ]);
    expect(clocks.every((c: { status: string }) => c.status === 'running')).toBe(true);
  });

  it('revising makes v2, a draft with the same items, and supersedes v1', async () => {
    const res = await owner.call('POST', `/api/orders/${orderId}/revise`, {});
    expect(res.status).toBe(200);
    const v2 = res.body.value.order;
    expect(v2).toMatchObject({
      number: `${number}-v2`,
      status: 'draft',
      revision: 2,
      seriesId: orderId,
      version: 1,
      total: inr(497_051),
    });
    expect(res.body.value.items.map((i: Item) => i.title).sort()).toEqual([
      'Bathroom',
      'Cabinet',
      'Kitchen',
      'Sink',
      'Tiles',
    ]);
    const v1 = (await owner.call('GET', `/api/orders/${orderId}`)).body;
    expect(v1).toMatchObject({ status: 'superseded', number });
    // Leaving submitted ended v1's clocks.
    const clocks = (await owner.call('GET', `/api/sla/orders/${orderId}`)).body;
    expect(clocks.every((c: { status: string }) => c.status === 'met')).toBe(true);
    // v2 is a draft: it changes, then it is submitted, approved and fulfilled.
    const changed = await save(owner, {
      orderId: v2.id,
      title: 'Versioned',
      items: rooms.slice(0, 3),
    });
    expect(changed.body.value.order.lineCount).toBe(2);
    expect((await move(owner, v2.id, 'submit')).body.value.status).toBe('submitted');
    const versions = (
      await owner.call('GET', `/api/history/versions?resourceType=order&resourceId=${v2.id}`)
    ).body;
    expect(versions.map((v: { revision: number; state: string }) => [v.revision, v.state])).toEqual(
      [
        [1, 'superseded'],
        [2, 'submitted'],
      ],
    );
    // Staff reach only their own orders, and may not approve even those; the owner may.
    expect((await move(staff, v2.id, 'approve', {}, inTenant())).status).toBe(404);
    const theirs = (await save(staff, { title: 'Staff own', items: [] }, inTenant())).body.value;
    await move(staff, theirs.order.id, 'submit', {}, inTenant());
    const notAllowed = await move(staff, theirs.order.id, 'approve', {}, inTenant());
    expect(notAllowed.status).toBe(403);
    expect(notAllowed.body.rule).toBe('transition_not_allowed');
    const approved = await move(owner, v2.id, 'approve');
    expect(approved.body.value.status).toBe('approved');
    // The approved order is the contract: never revised, never saved over.
    const revise = await owner.call('POST', `/api/orders/${v2.id}/revise`, {});
    expect(revise.body.rule).toBe('order_revise_submitted');
    expect((await save(owner, { orderId: v2.id, title: 'No', items: [] })).body.rule).toBe(
      'record_frozen',
    );
    expect((await move(owner, v2.id, 'fulfil')).body.value.status).toBe('fulfilled');
  });

  it("the assistant's submit waits for the person, its approve for an owner in the app", async () => {
    const draft = (await save(owner, { title: 'Asked to move', items: rooms })).body.value.order;
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const submit = await asks('POST', `/api/transitions/orders/${draft.id}/submit`, {});
    expect(submit.body.approval).toMatchObject({ tier: 2, input: { transition: 'submit' } });
    expect(
      (await owner.call('POST', `/api/approvals/${submit.body.approval.id}/approve`)).body.status,
    ).toBe('approved');
    const approve = await asks('POST', `/api/transitions/orders/${draft.id}/approve`, {});
    expect(approve.body.approval).toMatchObject({ tier: 3 });
    const { rows } = await pool.query(
      'select approver_roles, approver_channels, min_assurance from app.approvals where id = $1',
      [approve.body.approval.id],
    );
    expect(rows[0]).toEqual({
      approver_roles: ['owner'],
      approver_channels: ['app'],
      min_assurance: 'session',
    });
  });

  it('a decision overdue past its SLA tells the owners; a week later it expires', async () => {
    const order = (await save(owner, { title: 'Waiting long', items: rooms })).body.value.order;
    await move(owner, order.id, 'submit');
    const clocks = (await owner.call('GET', `/api/sla/orders/${order.id}`)).body as {
      sla: string;
      dueAt: string;
    }[];
    const decision = clocks.find((c) => c.sla === 'orders.decision') as { dueAt: string };
    const sweeper = server.app?.get(SlaService, { strict: false }) as SlaService;
    await sweeper.sweep(new Date(new Date(decision.dueAt).getTime() + 60_000));
    const breach = await pool.query(
      "select row from app.domain_events where resource_id = $1 and name = 'order.sla.breached'",
      [order.id],
    );
    expect(breach.rows.map((r) => r.row.sla.name)).toContain('orders.decision');
    // No phone to push to: the owner hears by email.
    const mail = await eventually(async () => {
      const res = await fetch(
        `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${owner.email}"`)}`,
      );
      const body = (await res.json()) as { messages: { Subject: string }[] };
      return body.messages.find((m) => m.Subject.includes(order.number));
    }, 15_000);
    expect(mail.Subject).toBe(`${order.number} is waiting for a decision`);
    // A week on, nobody decided: it expires, by the server itself.
    const expiry = clocks.find((c) => c.sla === 'orders.expiry') as { dueAt: string };
    await sweeper.sweep(new Date(new Date(expiry.dueAt).getTime() + 60_000));
    expect((await owner.call('GET', `/api/orders/${order.id}`)).body.status).toBe('expired');
    const { rows } = await pool.query(
      "select actor_kind from audit.events where resource_id = $1 and action = 'order.transition' and outcome = 'committed' order by at desc limit 1",
      [order.id],
    );
    expect(rows[0].actor_kind).toBe('system');
    // An expired order can still be revised.
    const revised = await owner.call('POST', `/api/orders/${order.id}/revise`, {});
    expect(revised.body.value.order.status).toBe('draft');
  });

  it("an assistant's save waiting for approval fails when the draft changed meanwhile", async () => {
    const draft = (await save(owner, { title: 'Pinned', items: rooms })).body.value.order;
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', '/api/orders/save', {
      orderId: draft.id,
      title: 'Pinned by the assistant',
      items: [],
    });
    expect(parked.body.status).toBe('needs_approval');
    await save(owner, { orderId: draft.id, title: 'Pinned by the owner', items: rooms });
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('failed');
    expect((await owner.call('GET', `/api/orders/${draft.id}`)).body.title).toBe(
      'Pinned by the owner',
    );
  });

  it('another business gets 404 for its moves, clocks, versions and a revise', async () => {
    const order = (await save(owner, { title: 'Ours', items: [] })).body.value.order;
    await move(owner, order.id, 'submit');
    expect((await move(stranger, order.id, 'cancel')).status).toBe(404);
    expect((await stranger.call('GET', `/api/sla/orders/${order.id}`)).status).toBe(404);
    expect(
      (
        await stranger.call(
          'GET',
          `/api/history/versions?resourceType=order&resourceId=${order.id}`,
        )
      ).status,
    ).toBe(404);
    expect((await stranger.call('POST', `/api/orders/${order.id}/revise`, {})).status).toBe(404);
  });
});

describe('who decides, and who sees the cost', () => {
  it("the assistant's save waits for the person; the number is taken only when it runs", async () => {
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', '/api/orders/save', { title: 'Asked', items: rooms });
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval).toMatchObject({ tier: 2, amount: 497_051 });
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
    expect(parked.body.approval).toMatchObject({ tier: 3, rule: 'order_over_limit' });
    // Staff cannot decide it; the owner can.
    const byStaff = await staff.call(
      'POST',
      `/api/approvals/${parked.body.approval.id}/approve`,
      undefined,
      inTenant(),
    );
    expect(byStaff.status).toBe(404);
    const byOwner = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(byOwner.body.status).toBe('approved');
    // The owner holds orders.approve: the same order saves at once.
    const direct = await save(owner, { title: 'Big too', items: big });
    expect(direct.body.status).toBe('done');
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
      "select status, payload->'input'->>'transition' as move from app.approvals where action = 'order.transition' and resource_id = $1",
      [saved.body.value.order.id],
    );
    expect(rows).toEqual([{ status: 'pending', move: 'cancel' }]);
  });
});
