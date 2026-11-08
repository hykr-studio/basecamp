// The sample application over MCP (A1): a person connects an outside AI client, the way Claude or
// an IDE does (registration, consent, PKCE), and works with every module through two tools per
// module. A to-do is added at once (the to-dos' internal level, undoable in the app); an order
// above the business's limit waits at the application's irreversible level, and the answer links
// to the request in the app; an order moves through its states (submit, then approve, which waits
// for the person in the app); an item's cost stays hidden from staff. Each tool says what it does
// (the orders' cancel cannot be undone), and the to-dos' "clear done" is offered only once the
// business switches its flag on.

import {
  addMember,
  boot,
  connectMcp,
  me,
  Person,
  pool,
  setTenantSettings,
  shutdown,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Mcp App');
const staff = new Person('Staff Mcp App');
let tenantId = '';
const inr = (minor: number) => ({ minor, currency: 'INR' });

/** The JSON after a tool's first line. */
const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1));

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, staff]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  expect((await staff.call('PUT', '/api/me/default', { tenantId })).status).toBe(200);
  // The business counts in INR and approves orders above 10,000.00 itself.
  await setTenantSettings(tenantId, {
    money: { currency: 'INR', fyStartMonth: 4, amounts: { 'orders.approval': inr(1_000_000) } },
  });
});
afterAll(shutdown);

describe('the sample application over MCP', () => {
  it('offers two tools per module the person allowed', async () => {
    const all = await connectMcp(
      owner,
      'todos:write notes:write meetings:write orders:write offline_access',
    );
    expect(await all.tools()).toEqual([
      'meetings_read',
      'meetings_write',
      'notes_read',
      'notes_write',
      'orders_read',
      'orders_write',
      'todos_read',
      'todos_write',
    ]);
    await all.close();
    const reader = await connectMcp(owner, 'todos:read orders:read');
    expect(await reader.tools()).toEqual(['orders_read', 'todos_read']);
    await reader.close();
  });

  it('adds a to-do at once, undoable by the person in the app', async () => {
    const c = await connectMcp(owner, 'todos:write');
    const made = await c.call('todos_write', {
      action: 'create-todo',
      input: { title: 'Call the plumber' },
    });
    expect(made.isError).toBe(false);
    expect(made.text).toContain('undo it in the app');
    const listed = await c.call('todos_read', { entity: 'todos', query: { q: 'plumber' } });
    expect(jsonOf(listed.text).items.map((t: { title: string }) => t.title)).toContain(
      'Call the plumber',
    );
    const { rows } = await pool.query(
      `select actor_id, channel from audit.events where action = 'todo.create' and tenant_id = $1 order by at desc limit 1`,
      [tenantId],
    );
    expect(rows[0]).toEqual({ actor_id: `mcp:${c.clientId}`, channel: 'mcp' });
    await c.close();
  });

  it('an order above the limit waits for a person, with the link to it in the app', async () => {
    const c = await connectMcp(owner, 'orders:write');
    const asked = await c.call('orders_write', {
      action: 'save-order',
      input: {
        title: 'Marble hall',
        items: [{ ref: 'a', title: 'Marble', quantity: 100, unitPrice: '500' }],
      },
    });
    expect(asked.isError).toBe(false);
    expect(asked.text).toContain('Not done yet');
    expect(asked.text).toContain('Level: Money or irreversible.');
    const id = /\/approvals\/([0-9a-f-]{36})/.exec(asked.text)?.[1] ?? '';
    expect(asked.text).toContain(
      `${process.env.APP_URL ?? 'http://localhost:8081'}/approvals/${id}`,
    );
    const approval = (await owner.call('GET', `/api/approvals/${id}`)).body;
    expect(approval).toMatchObject({
      status: 'pending',
      level: { name: 'irreversible' },
      amount: inr(5_000_000),
      requestedBy: 'agent',
    });
    // Nothing was saved; the person decides in the app.
    const { rows } = await pool.query(
      'select count(*)::int as n from app.orders where tenant_id = $1 and title = $2',
      [tenantId, 'Marble hall'],
    );
    expect(rows[0].n).toBe(0);
    await c.close();
  });

  it('moves an order through its states; its approve waits for the person in the app', async () => {
    const c = await connectMcp(owner, 'orders:write');
    try {
      const saved = await owner.call('POST', '/api/orders/save', {
        title: 'Small bath',
        items: [{ ref: 'b', title: 'Tiles', quantity: 2, unitPrice: '100' }],
      });
      const orderId = saved.body.value.order.id;
      // The client's submit waits for the person (the orders' own rule for an agent's moves).
      const submit = await c.call('orders_write', {
        action: 'transition-orders',
        input: { id: orderId, transition: 'submit' },
      });
      expect(submit.isError).toBe(false);
      expect(submit.text).toContain('Not done yet');
      const submitId = /\/approvals\/([0-9a-f-]{36})/.exec(submit.text)?.[1] ?? '';
      expect((await owner.call('POST', `/api/approvals/${submitId}/approve`)).body.status).toBe(
        'approved',
      );
      expect((await owner.call('GET', `/api/orders/${orderId}`)).body.status).toBe('submitted');
      // Its approve is the application's irreversible level: a named person (the one the client
      // acts for), in the app, signed in. The answer links there.
      const approve = await c.call('orders_write', {
        action: 'transition-orders',
        input: { id: orderId, transition: 'approve' },
      });
      expect(approve.isError).toBe(false);
      expect(approve.text).toContain('Level: Money or irreversible.');
      expect(approve.text).toContain('The person you act for decides it.');
      const approveId = /\/approvals\/([0-9a-f-]{36})/.exec(approve.text)?.[1] ?? '';
      expect(approve.text).toContain(
        `${process.env.APP_URL ?? 'http://localhost:8081'}/approvals/${approveId}`,
      );
      const { rows } = await pool.query(
        'select status, approver_user_id, approver_channels, min_assurance, run_id from app.approvals where id = $1',
        [approveId],
      );
      expect(rows[0]).toMatchObject({
        status: 'pending',
        approver_user_id: owner.id,
        approver_channels: ['app'],
        min_assurance: 'session',
      });
      expect(rows[0].run_id).toMatch(/^mcp-/);
      expect((await owner.call('GET', `/api/orders/${orderId}`)).body.status).toBe('submitted');
      // A person's own move (fulfil) is not the client's to make.
      const fulfil = await c.call('orders_write', {
        action: 'transition-orders',
        input: { id: orderId, transition: 'fulfil' },
      });
      expect(fulfil.isError).toBe(true);
      expect(fulfil.text).toContain('input.transition must be one of submit, approve, cancel');
    } finally {
      await c.close();
    }
  });

  it('says which tools only read, and which can do what cannot be undone', async () => {
    const c = await connectMcp(owner, 'todos:write meetings:write orders:write');
    const notes = await c.annotations();
    for (const read of ['todos_read', 'meetings_read', 'orders_read'])
      expect(notes[read], read).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // Orders are never deleted, but a cancelled one never comes back (the module marks it).
    expect(notes.orders_write).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // Meetings are deleted by people only, and nothing else of theirs is destructive.
    expect(notes.meetings_write).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    await c.close();
  });

  it('offers "clear done" only once the business switches its flag on', async () => {
    const clear = async () => {
      const c = await connectMcp(owner, 'todos:write');
      try {
        return await c.call('todos_write', { action: 'clear-done-todos', input: {} });
      } finally {
        await c.close();
      }
    };
    const off = await clear();
    expect(off.isError).toBe(true);
    expect(off.text).not.toContain('Not done yet');
    await setTenantSettings(tenantId, { features: { 'todos.clear-done': true } });
    try {
      // The assistant's call waits for the person's approval, and so does the client's.
      const on = await clear();
      expect(on.isError).toBe(false);
      expect(on.text).toContain('Not done yet');
    } finally {
      await setTenantSettings(tenantId, { features: null });
    }
  });

  it("keeps an item's cost hidden from staff", async () => {
    const saved = await staff.call('POST', '/api/orders/save', {
      title: 'Small kitchen',
      items: [{ ref: 'k', title: 'Cabinet', quantity: 1, unitPrice: '100', cost: '60' }],
    });
    const orderId = saved.body.value.order.id;
    const { rows: stored } = await pool.query(
      'select cost from app.orders_items where order_id = $1',
      [orderId],
    );
    expect(Number(stored[0].cost)).toBe(6000);
    const c = await connectMcp(staff, 'orders:read');
    const items = await c.call('orders_read', { entity: 'orderItems', query: { orderId } });
    expect(items.isError).toBe(false);
    const rows = jsonOf(items.text).items;
    expect(rows.map((i: { title: string }) => i.title)).toEqual(['Cabinet']);
    expect(rows[0]).not.toHaveProperty('cost');
    await c.close();
  });
});
