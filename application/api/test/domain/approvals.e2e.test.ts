// The sample's approval levels at work on a send to a customer (notify.send is `external` here):
// the assistant's send waits for the person it is for, who decides it; a marketing send waits for
// the holders of marketing.approve, never the person who asked.

import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  seedContact,
  shutdown,
  stamp,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Compiled, like the app runs: Nest's DI needs the decorator metadata tsc emits.
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Sends');
const admin = new Person('Admin Sends');
const other = new Person('Other Sends');
let tenantId = '';
let customerId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const service = () => ({ customerId, template: 'todo_due_v1', params: { title: 'Order tiles' } });
const outbox = async (template: string) =>
  (
    await pool.query(
      'select count(*)::int as n from app.outbox where tenant_id = $1 and key = $2',
      [tenantId, `template:${template}`],
    )
  ).rows[0].n as number;

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, admin, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(admin, tenantId, ['admin']);
  ({ customerId } = await seedContact(tenantId, 'Divya Sends', `+9196${stamp % 1e8}`));
});
afterAll(shutdown);

describe('a send to a customer goes outside', () => {
  it("the owner's assistant sends a service template: it waits for the owner, who approves it", async () => {
    const before = await outbox('todo_due_v1');
    const sent = await asAssistant(`user:${owner.id}`)('POST', '/api/notify/send', service());
    expect(sent.body).toMatchObject({
      status: 'needs_approval',
      approval: {
        rule: 'send_goes_outside',
        level: { name: 'external', rank: 2, label: { en: 'Goes outside' } },
        decider: { by: 'requester', userId: owner.id },
      },
    });
    const { id } = sent.body.approval;
    expect(await outbox('todo_due_v1')).toBe(before); // parked, not sent

    // The park is audited with its level.
    const { rows } = await pool.query(
      `select action, outcome, after from audit.events where after->>'approvalId' = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({
      action: 'notify.send',
      outcome: 'needs_approval',
      after: { approvalId: id, level: 'external' },
    });

    // It waits for the owner, and nobody outside the business sees it.
    const waiting = (await owner.call('GET', '/api/approvals')).body;
    expect(waiting.find((a: { id: string }) => a.id === id)).toMatchObject({ canDecide: true });
    expect((await other.call('GET', `/api/approvals/${id}`)).status).toBe(404);
    expect((await other.call('POST', `/api/approvals/${id}/approve`)).status).toBe(404);

    const ok = await owner.call('POST', `/api/approvals/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved' });
    expect(await outbox('todo_due_v1')).toBe(before + 1);
  });

  it('the owner sending it themselves is the person it needs: it runs at once', async () => {
    const before = await outbox('todo_due_v1');
    const sent = await owner.call('POST', '/api/notify/send', service());
    expect(sent.body).toMatchObject({ status: 'done', value: { queued: true } });
    expect(await outbox('todo_due_v1')).toBe(before + 1);
  });

  it('a marketing send waits for the holders of marketing.approve: an admin, not the owner who asked', async () => {
    const sent = await asAssistant(`user:${owner.id}`)('POST', '/api/notify/send', {
      customerId,
      template: 'monthly_update_v1',
      params: { name: 'Divya', news: 'Open on Sundays' },
    });
    expect(sent.body).toMatchObject({
      status: 'needs_approval',
      approval: {
        rule: 'marketing_send',
        level: { name: 'external' },
        decider: { by: 'capability', capability: 'marketing.approve' },
      },
    });
    const { id } = sent.body.approval;
    expect(await owner.call('POST', `/api/approvals/${id}/approve`)).toMatchObject({
      status: 403,
      body: { rule: 'own_request' },
    });
    const ok = await admin.call('POST', `/api/approvals/${id}/approve`, undefined, inTenant());
    expect(ok.body).toMatchObject({ status: 'approved' });
  });
});
