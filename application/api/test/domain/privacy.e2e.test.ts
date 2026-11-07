// Personal data (B18) in the sample: a note about a customer is that customer's personal data
// (notes' `privacy` trait). The customer's copy holds their notes; the application's policy gives
// the deadline and its processors fill the register; notes expire two years after their last
// change; and when the team files an erasure for someone, it waits for a second person
// (`irreversible`), then forgets them and their notes. Another customer's notes stay.
import { PrivacyService, readZip } from '@hykr/api';
import {
  addMember,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Privacy');
const ops = new Person('Ops Privacy');
const asha = new Person('Asha Privacy'); // a customer
const bala = new Person('Bala Privacy'); // another customer
let tenantId = '';
const customer: Record<string, string> = {};
const here = () => ({ 'x-tenant-id': tenantId });
const call = (p: Person, method: string, path: string, body?: unknown) =>
  p.call(method, path, body, here());
const privacy = () => server.app?.get(PrivacyService, { strict: false }) as PrivacyService;

/** A person as a customer of the business only. */
async function makeCustomer(p: Person) {
  const { rows } = await pool.query(
    'insert into app.customers (tenant_id, display_name, user_id) values ($1, $2, $3) returning id',
    [tenantId, p.name, p.id],
  );
  await pool.query('delete from app.memberships where user_id = $1', [p.id]);
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, customer_id, is_default)
     values ($1, $2, '{customer}', $3, true)`,
    [tenantId, p.id, rows[0].id],
  );
  customer[p.name] = rows[0].id;
}

/** A note the owner keeps about a customer. */
async function noteAbout(p: Person, title: string) {
  const note = (await call(owner, 'POST', '/api/notes', { title, body: `About ${p.name}` })).body
    .value;
  await pool.query('update app.notes set customer_id = $2 where id = $1', [
    note.id,
    customer[p.name],
  ]);
  return note.id as string;
}

const finished = (p: Person, id: string) =>
  eventually(async () => {
    const res = await call(p, 'GET', `/api/privacy/requests/${id}`);
    return ['completed', 'failed', 'refused'].includes(res.body?.status) ? res.body : undefined;
  }, 30_000);

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, ops, asha, bala]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(ops, tenantId, ['ops']);
  await makeCustomer(asha);
  await makeCustomer(bala);
});
afterAll(shutdown);

describe('personal data in the sample', () => {
  it("a customer's copy holds the notes about them, answered within the application's 30 days", async () => {
    await noteAbout(asha, 'Asha likes oak');
    await noteAbout(bala, 'Bala likes teak');
    const res = await call(asha, 'POST', '/api/privacy/requests', { kind: 'export' });
    expect(res.status).toBe(200);
    const req = res.body.value;
    expect(Date.parse(req.dueAt) - Date.parse(req.receivedAt)).toBe(30 * 86_400_000);
    const done = await finished(asha, req.id);
    const file = await call(asha, 'GET', `/api/files/${done.files[0]}`);
    const zip = readZip(
      Buffer.from(await (await fetch(`${server.base}${file.body.url}`)).arrayBuffer()),
    );
    const notes = JSON.parse(zip.get('records/notes.json')?.toString('utf8') ?? '[]') as Json[];
    expect(notes.map((n) => n.title)).toEqual(['Asha likes oak']);
    expect(Object.keys(notes[0]).sort()).toEqual([
      'body',
      'createdAt',
      'id',
      'photos',
      'title',
      'updatedAt',
    ]);
  });

  it('the register names the application’s processors and the notes’ rule, in Hindi too', async () => {
    const reg = (await call(owner, 'GET', '/api/privacy/register?lang=hi')).body;
    expect(reg.processors.map((p: Json) => p.name)).toEqual([
      'Model gateway',
      'WhatsApp Business Platform',
      'Email provider',
      'Speech service',
    ]);
    expect(reg.processors[1].purpose).toContain('WhatsApp');
    expect(reg.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: 'note',
          module: 'notes',
          erase: 'delete',
          retention: 'notes.personal',
        }),
      ]),
    );
    const period = (name: string) => reg.retention.find((r: Json) => r.name === name)?.days;
    expect(period('notes.personal')).toBe(730);
    expect(period('channel.inbound-payloads')).toBe(30);
    expect(period('privacy.archives')).toBe(90);
  });

  it('notes about a customer go two years after their last change', async () => {
    const old = await noteAbout(bala, 'Bala, long ago');
    const team = (await call(owner, 'POST', '/api/notes', { title: 'Nobody’s note' })).body.value
      .id;
    await pool.query(
      `update app.notes set updated_at = now() - interval '800 days' where id = any($1)`,
      [[old, team]],
    );
    expect(await privacy().runRetention({ tenantId })).toMatchObject({ 'notes.personal': 1 });
    const left = await pool.query('select id from app.notes where id = any($1)', [[old, team]]);
    expect(left.rows.map((r) => r.id)).toEqual([team]);
  });

  it('an erasure the team files waits for a second person, then forgets the customer', async () => {
    const res = await call(owner, 'POST', '/api/privacy/requests', {
      kind: 'erase',
      for: { email: asha.email },
      intake: 'email',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('needs_approval');
    expect(res.body.approval.level).toMatchObject({ name: 'irreversible' });
    const approved = await call(ops, 'POST', `/api/approvals/${res.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const filed = await eventually(async () => {
      const list = await call(owner, 'GET', '/api/privacy/requests?kind=erase');
      return list.body.items.find(
        (r: Json) => r.subject.id === asha.id && r.status === 'completed',
      );
    }, 30_000);
    expect(filed.outcome).toMatchObject({ records: { notes: { deleted: 1 } }, account: true });
    const left = await pool.query('select title from app.notes where customer_id = any($1)', [
      [customer[asha.name], customer[bala.name]],
    ]);
    expect(left.rows.map((r) => r.title)).toEqual(['Bala likes teak']);
    expect((await asha.call('GET', '/api/me')).status).toBe(401);
  });
});
