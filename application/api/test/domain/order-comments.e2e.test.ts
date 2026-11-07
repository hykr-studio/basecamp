// Comments on orders: the framework's comments, configured by the orders module. A mention
// reaches the person's in-app inbox (the framework's notification) and, with no phone
// registered, their email (the module's push-then-email notification). A comment a customer
// could read is at the application's `external` level, so the assistant's waits for the person;
// a team-only one does not. A business that makes `external` always wait parks people's comments
// and every edit of them.

import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  shutdown,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const owner = new Person('Owner Comments');
const admin = new Person('Admin Comments');
const staff = new Person('Staff Comments');
let tenantId = '';
let orderId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

async function subjectsTo(email: string): Promise<string[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return ((await res.json()) as { messages: { Subject: string }[] }).messages.map((m) => m.Subject);
}

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, admin, staff]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(admin, tenantId, ['admin']);
  await addMember(staff, tenantId, ['staff']);
  const saved = await owner.call('POST', '/api/orders/save', {
    title: 'Corner shelf',
    items: [{ ref: 'l1', title: 'Shelf', quantity: 1, unitPrice: '100.00' }],
  });
  orderId = saved.body.value.order.id;
});
afterAll(shutdown);

describe('comments on an order', () => {
  it('a mention reaches the inbox with a link to the order, and the email', async () => {
    const res = await owner.call('POST', '/api/comments', {
      entity: 'order',
      recordId: orderId,
      body: `Can you check the price, @[Admin](user:${admin.id})?`,
    });
    expect(res.body).toMatchObject({
      status: 'done',
      value: { mentions: [{ kind: 'user', id: admin.id, label: 'Admin Comments' }] },
    });
    const item = await eventually(
      async () => (await admin.call('GET', '/api/inbox', undefined, inTenant())).body.items[0],
    );
    expect(item).toMatchObject({
      title: 'Owner Comments mentioned you',
      body: 'Can you check the price, @Admin Comments?',
      record: { type: 'order', id: orderId },
    });
    await eventually(async () =>
      (await subjectsTo(admin.email)).includes('Owner Comments mentioned you on an order')
        ? true
        : undefined,
    );
  });

  it('someone who cannot read the order cannot be named, and cannot read its comments', async () => {
    const res = await owner.call('POST', '/api/comments', {
      entity: 'order',
      recordId: orderId,
      body: `FYI @[Staff](user:${staff.id})`,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'mention_not_allowed' });
    const read = await staff.call(
      'GET',
      `/api/comments?entity=order&id=${orderId}`,
      undefined,
      inTenant(),
    );
    expect(read.status).toBe(404);
  });

  it("the assistant's comment waits for the person; a team-only one does not", async () => {
    const run = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const parked = await run('POST', '/api/comments', {
      entity: 'order',
      recordId: orderId,
      body: 'The shelf ships Monday.',
    });
    // The orders module puts it at the application's `external` level, decided by the person.
    expect(parked.body).toMatchObject({
      status: 'needs_approval',
      approval: {
        resourceType: 'order',
        resourceId: orderId,
        level: { name: 'external' },
      },
    });
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const internal = await run('POST', '/api/comments', {
      entity: 'order',
      recordId: orderId,
      body: 'Margin is thin on this one.',
      internal: true,
    });
    expect(internal.body).toMatchObject({ status: 'done', value: { internal: true } });
    const history = await owner.call(
      'GET',
      `/api/history?resourceType=order&resourceId=${orderId}`,
    );
    expect(history.body.map((e: { action: string }) => e.action)).toContain('comment.add');
  });

  it('a business that makes `external` wait parks a comment, and every edit of it', async () => {
    // A write reads the business's settings in its own transaction.
    const approvals = (value: object) =>
      pool.query(
        `update app.tenants set settings = jsonb_set(settings, '{approvals}', $2::jsonb) where id = $1`,
        [tenantId, JSON.stringify(value)],
      );
    const comment = (body: string, internal = false) =>
      admin.call(
        'POST',
        '/api/comments',
        { entity: 'order', recordId: orderId, body, internal },
        inTenant(),
      );
    const edit = (id: string, body: string) =>
      admin.call('PATCH', `/api/comments/${id}`, { body }, inTenant());
    const approve = (id: string) =>
      admin.call('POST', `/api/approvals/${id}/approve`, undefined, inTenant());
    await approvals({ levels: { external: { parks: true } } });
    try {
      const parked = await comment('Fitting is on Tuesday.');
      expect(parked.body).toMatchObject({
        status: 'needs_approval',
        approval: { resourceType: 'order', resourceId: orderId, level: { name: 'external' } },
      });
      expect((await approve(parked.body.approval.id)).body).toMatchObject({ status: 'approved' });
      const list = await admin.call(
        'GET',
        `/api/comments?entity=order&id=${orderId}`,
        undefined,
        inTenant(),
      );
      const approved = list.body.items.find(
        (c: { body: string }) => c.body === 'Fitting is on Tuesday.',
      );
      // Its new text, and a new mention, wait as the comment did.
      const changed = await edit(approved.id, `Fitting moved, @[Owner](user:${owner.id})`);
      expect(changed.body).toMatchObject({
        status: 'needs_approval',
        approval: { resourceType: 'order', resourceId: orderId, level: { name: 'external' } },
      });
      // A team-only note stays inside: it and its edits run at once.
      const note = await comment('Check stock first.', true);
      expect(note.body).toMatchObject({ status: 'done' });
      expect((await edit(note.body.value.id, 'Stock checked.')).body).toMatchObject({
        status: 'done',
      });
    } finally {
      await approvals({});
    }
  });
});
