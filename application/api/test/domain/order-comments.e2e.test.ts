// Comments on orders: the framework's comments, configured by the orders module. A mention
// reaches the person's in-app inbox (the framework's notification) and, with no phone
// registered, their email (the module's push-then-email notification). The assistant's comment
// waits for the person unless it is team-only.

import { addMember, asAssistant, boot, eventually, me, Person, shutdown } from '@hykr/api/testing';
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
    expect(parked.body).toMatchObject({
      status: 'needs_approval',
      approval: { resourceType: 'order', resourceId: orderId },
    });
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
});
