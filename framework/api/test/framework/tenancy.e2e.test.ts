// Businesses (tenants), roles and customers, with no domain: the framework's page entity and a
// fixture-free path through the API. Each sign-up owns a business; ops see their whole
// business; a WhatsApp contact without an account is a customer who sees only their own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  seedContact,
  shutdown,
} from '../../dist/testing.js';
// The framework's fixture application, compiled (Nest's DI needs the decorator metadata).
import { fixture } from '../fixture/dist/index.js';

const owner = new Person('Owner Tenancy');
const ops = new Person('Ops Tenancy');
const stranger = new Person('Stranger Tenancy');
let tenantId = '';

beforeAll(async () => {
  await boot(fixture);
  for (const p of [owner, ops, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(ops, tenantId, ['ops']);
});
afterAll(shutdown);

const visit = (title: string) => ({
  title,
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  endsAt: new Date(Date.now() + 90_000_000).toISOString(),
});

describe('businesses', () => {
  it('a sign-up owns its own business', async () => {
    expect(await me(owner)).toMatchObject({ roles: ['owner'] });
    expect((await me(stranger)).tenantId).not.toBe(tenantId);
  });

  it('a person works in a business they belong to, and no other', async () => {
    const res = await ops.call('GET', '/api/me', undefined, { 'x-tenant-id': tenantId });
    expect(res.body).toMatchObject({ tenantId, roles: ['ops'] });
    const elsewhere = await stranger.call('GET', '/api/me', undefined, { 'x-tenant-id': tenantId });
    expect(elsewhere.status).toBe(403);
  });

  it('ops see the whole business; nobody outside it sees anything', async () => {
    const made = await owner.call('POST', '/api/visits', visit('Owner planning'));
    expect(made.status).toBe(201);
    const id = made.body.value.id;
    const asOps = await ops.call('GET', `/api/visits/${id}`, undefined, {
      'x-tenant-id': tenantId,
    });
    expect(asOps.status).toBe(200);
    expect((await stranger.call('GET', `/api/visits/${id}`)).status).toBe(404);
    const { rows } = await pool.query('select tenant_id from app.fixture_visits where id = $1', [
      id,
    ]);
    expect(rows[0].tenant_id).toBe(tenantId);
  });
});

describe('customers on WhatsApp (no account)', () => {
  it('book for themselves: the record is theirs, owned by the business', async () => {
    const asha = await seedContact(tenantId, 'Asha', '919000000101');
    const ravi = await seedContact(tenantId, 'Ravi', '919000000102');
    const asAsha = asAssistant(`contact:${asha.contactId}`);
    const asRavi = asAssistant(`contact:${ravi.contactId}`);

    const made = await asAsha('POST', '/api/visits', visit('Asha site visit'));
    expect(made.status).toBe(201);
    const id = made.body.value.id;
    const { rows } = await pool.query(
      'select owner_id, customer_id, tenant_id from app.fixture_visits where id = $1',
      [id],
    );
    expect(rows[0]).toEqual({
      owner_id: owner.id,
      customer_id: asha.customerId,
      tenant_id: tenantId,
    });

    // Asha sees hers; Ravi gets nothing (a 404, never a hint); the owner sees it in their list.
    expect((await asAsha('GET', `/api/visits/${id}`)).status).toBe(200);
    expect((await asRavi('GET', `/api/visits/${id}`)).status).toBe(404);
    expect((await asRavi('GET', '/api/visits')).body.items).toEqual([]);
    const listed = (await owner.call('GET', '/api/visits')).body.items.map(
      (m: { id: string }) => m.id,
    );
    expect(listed).toContain(id);

    // The audit row says who, for whom, and how it came in.
    const audit = await pool.query(
      `select actor_kind, acting_for, subject_kind, tenant_id, channel from audit.events
       where action = 'visit.create' and resource_id = $1`,
      [id],
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: 'agent',
        acting_for: `contact:${asha.contactId}`,
        subject_kind: 'contact',
        tenant_id: tenantId,
        channel: 'whatsapp',
      },
    ]);
  });

  it("a customer's delete waits for the business: owner and ops may decide, not the customer", async () => {
    const asha = await seedContact(tenantId, 'Asha Two', '919000000103');
    const asAsha = asAssistant(`contact:${asha.contactId}`);
    const id = (await asAsha('POST', '/api/visits', visit('Asha cancel me'))).body.value.id;

    const parked = await asAsha('DELETE', `/api/visits/${id}`);
    // Visits are deleted by people only; a task shows the approval path.
    expect(parked.status).toBe(403);
    const task = (await asAsha('POST', '/api/tasks', { title: 'Asha bring samples' })).body.value;
    const asked = await asAsha('DELETE', `/api/tasks/${task.id}`);
    expect(asked.body).toMatchObject({ status: 'needs_approval' });
    const approvalId = asked.body.approval.id;

    // The owner and ops see it; someone outside the business does not.
    const ownerList = (await owner.call('GET', '/api/approvals')).body.map(
      (a: { id: string }) => a.id,
    );
    expect(ownerList).toContain(approvalId);
    const opsList = (
      await ops.call('GET', '/api/approvals', undefined, { 'x-tenant-id': tenantId })
    ).body.map((a: { id: string }) => a.id);
    expect(opsList).toContain(approvalId);
    expect((await stranger.call('GET', `/api/approvals/${approvalId}`)).status).toBe(404);

    // Ops decide; the delete runs as Asha's request, approved by ops; a second decision is refused.
    const approved = await ops.call('POST', `/api/approvals/${approvalId}/approve`, undefined, {
      'x-tenant-id': tenantId,
    });
    expect(approved.body).toMatchObject({ status: 'approved' });
    expect((await asAsha('GET', `/api/tasks/${task.id}`)).status).toBe(404);
    const again = await owner.call('POST', `/api/approvals/${approvalId}/reject`);
    expect(again.status).toBe(409);
  });

  it('an unknown contact is nobody: 401', async () => {
    const res = await asAssistant('contact:no-such-contact')('GET', '/api/tasks');
    expect(res.status).toBe(401);
  });
});
