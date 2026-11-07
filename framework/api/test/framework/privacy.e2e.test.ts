// Personal data (B18), against the fixture's `ledgers` module (fixture/src/features/privacy):
// cards deleted when their customer is forgotten (and after 30 days), ledger entries kept for a
// legal hold, callers anonymised. A customer asks for a copy and gets their personal data only;
// another business, the team without `privacy.manage` and the assistant reach neither the
// request nor the archive; erasure deletes, keeps and blanks as declared, redacts the copies the
// server keeps, and forgets the account; a business that reviews erasures makes them wait, and
// processing one parks for an approval; deadlines are marked once; retention runs per business
// with its own periods; the register lists who holds what.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrivacyService, readZip } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  seedContact,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { privacyApp } from '../fixture/dist/features/privacy/index.js';

const ana = new Person('Ana Privacy'); // owner of the business
const bob = new Person('Bob Privacy'); // staff
const carol = new Person('Carol Privacy'); // admin: handles privacy requests
const cy = new Person('Cy Privacy'); // a customer, forgotten in the end
const dee = new Person('Dee Privacy'); // a customer whose erasure is reviewed
const eve = new Person('Eve Privacy'); // a customer whose cards expire
const ravi = new Person('Ravi Privacy'); // owner of another business
let tenantId = '';
let raviTenant = '';
const customer: Record<string, string> = {};

const here = (extra: Record<string, string> = {}) => ({ 'x-tenant-id': tenantId, ...extra });
const call = (p: Person, method: string, path: string, body?: unknown) =>
  p.call(method, path, body, here());

const privacy = () => server.app?.get(PrivacyService, { strict: false }) as PrivacyService;

/** A person as a customer of the business, and nowhere else. */
async function makeCustomer(p: Person): Promise<string> {
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
  return rows[0].id as string;
}

const file = (p: Person, kind: string, extra: Json = {}) =>
  call(p, 'POST', '/api/privacy/requests', { kind, ...extra });

/** The request once it has finished, as this person reads it. */
const finished = (p: Person, id: string) =>
  eventually(async () => {
    const res = await call(p, 'GET', `/api/privacy/requests/${id}`);
    return ['completed', 'failed', 'refused'].includes(res.body?.status) ? res.body : undefined;
  }, 20_000);

/** An archive's files, downloaded as this person. */
async function archive(p: Person, fileId: string) {
  const got = await call(p, 'GET', `/api/files/${fileId}`);
  expect(got.status).toBe(200);
  expect(got.body).toMatchObject({ mime: 'application/zip' });
  const res = await fetch(`${server.base}${got.body.url}`);
  expect(res.status).toBe(200);
  return readZip(Buffer.from(await res.arrayBuffer()));
}
const json = (zip: Map<string, Buffer>, name: string) =>
  JSON.parse(zip.get(name)?.toString('utf8') ?? 'null') as Json;

const auditOf = async (action: string, resourceId: string) =>
  (
    await pool.query(
      `select action, outcome, actor_kind, rule, after from audit.events
       where action = $1 and resource_id = $2 order by at`,
      [action, resourceId],
    )
  ).rows;

const mastraSpans = async () =>
  (await pool.query("select to_regclass('mastra_obs.mastra_span_events') is not null as ok"))
    .rows[0].ok as boolean;

beforeAll(async () => {
  await boot(privacyApp);
  for (const p of [ana, bob, carol, cy, dee, eve, ravi]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  raviTenant = (await me(ravi)).tenantId;
  await addMember(bob, tenantId, ['staff']);
  await addMember(carol, tenantId, ['admin']);
  for (const p of [cy, dee, eve]) customer[p.name] = await makeCustomer(p);
  await setTenantSettings(tenantId, { privacy: null });
});

afterAll(shutdown);

describe('a copy of my data', () => {
  let requestId = '';
  let fileId = '';

  it("holds the person's personal data only, from every part", async () => {
    for (const name of ['Cy one', 'Cy two'])
      expect(
        (await call(cy, 'POST', '/api/cards', { name, phone: '+91 90000 00001', amountMinor: 700 }))
          .status,
      ).toBe(201);
    await call(cy, 'POST', '/api/ledgerEntries', { payer: 'Cy Payer', amountMinor: 900 });
    await call(dee, 'POST', '/api/cards', { name: 'Dee card', phone: '+91 90000 00002' });
    expect(
      (await cy.call('POST', '/api/chat/once', { message: 'hello there' }, here())).status,
    ).toBeLessThan(300);

    const res = await file(cy, 'export');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    const req = res.body.value;
    expect(req).toMatchObject({
      kind: 'export',
      status: 'in_progress',
      intake: 'app',
      subject: { kind: 'user', id: cy.id },
      requestedBy: { kind: 'user', id: cy.id },
    });
    // The fixture's policy: answered within 30 days.
    expect(Date.parse(req.dueAt) - Date.parse(req.receivedAt)).toBe(30 * 86_400_000);
    requestId = req.id;

    const done = await finished(cy, requestId);
    expect(done.status).toBe('completed');
    expect(done.files).toHaveLength(1);
    fileId = done.files[0];
    const zip = await archive(cy, fileId);
    const manifest = json(zip, 'manifest.json');
    expect(manifest).toMatchObject({ version: 1, tenantId, subject: { kind: 'user', id: cy.id } });
    const cards = json(zip, 'records/cards.json');
    expect(cards.map((c: Json) => c.name).sort()).toEqual(['Cy one', 'Cy two']);
    // Personal fields, ids and dates only: the amount is the business's.
    expect(Object.keys(cards[0]).sort()).toEqual(['createdAt', 'id', 'name', 'phone', 'updatedAt']);
    expect(json(zip, 'records/ledgerEntries.json')).toMatchObject([{ payer: 'Cy Payer' }]);
    expect(json(zip, 'account.json')).toMatchObject([{ id: cy.id, email: cy.email }]);
    expect(json(zip, 'memberships.json')).toMatchObject([{ tenantId, roles: ['customer'] }]);
    expect(json(zip, 'thread-messages.json').map((m: Json) => m.text)).toContain('hello there');
    expect(json(zip, 'activity.json').some((a: Json) => a.action === 'card.create')).toBe(true);
    expect(json(zip, 'privacy-requests.json')).toMatchObject([{ id: requestId, kind: 'export' }]);
    expect(manifest.parts.map((x: Json) => x.name)).toEqual(
      expect.arrayContaining(['account', 'records/cards', 'assistant-runs', 'privacy-requests']),
    );
    expect(await auditOf('privacy.request', requestId)).toMatchObject([
      { outcome: 'committed', actor_kind: 'user', rule: 'privacy_own_request' },
    ]);
    expect(await auditOf('privacy.exported', requestId)).toHaveLength(1);
  });

  it('is reached by its person and the privacy team, by nobody else', async () => {
    // Staff, another customer, another business, the assistant: 404 or nothing.
    expect((await call(bob, 'GET', `/api/privacy/requests/${requestId}`)).status).toBe(404);
    expect((await call(bob, 'GET', `/api/files/${fileId}`)).status).toBe(404);
    expect((await call(dee, 'GET', `/api/privacy/requests/${requestId}`)).status).toBe(404);
    expect((await call(dee, 'GET', `/api/files/${fileId}`)).status).toBe(404);
    expect(
      (
        await ravi.call('GET', `/api/privacy/requests/${requestId}`, undefined, {
          'x-tenant-id': raviTenant,
        })
      ).status,
    ).toBe(404);
    expect(
      (await ravi.call('GET', `/api/files/${fileId}`, undefined, { 'x-tenant-id': raviTenant }))
        .status,
    ).toBe(404);
    expect((await call(bob, 'GET', '/api/privacy/requests')).body.items).toEqual([]);
    const assistant = asAssistant(`user:${cy.id}`, { 'x-tenant-id': tenantId });
    expect((await assistant('GET', '/api/privacy/requests')).body.items).toEqual([]);
    expect((await assistant('GET', `/api/privacy/requests/${requestId}`)).status).toBe(404);
    // People only: the assistant files nothing.
    expect((await assistant('POST', '/api/privacy/requests', { kind: 'erase' })).status).toBe(403);

    // The person, and the privacy team (Carol, an admin; Ana, the owner).
    expect(
      (await call(cy, 'GET', '/api/privacy/requests')).body.items.map((r: Json) => r.id),
    ).toEqual([requestId]);
    for (const p of [ana, carol]) {
      expect((await call(p, 'GET', `/api/privacy/requests/${requestId}`)).status).toBe(200);
      expect((await call(p, 'GET', `/api/files/${fileId}`)).status).toBe(200);
    }
    expect((await call(carol, 'GET', '/api/privacy/requests?mine=true')).body.items).toEqual([]);
  });

  it('is filed for someone else only by the privacy team, for someone the business knows', async () => {
    const refused = await file(bob, 'export', { for: { userId: dee.id } });
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('needs_privacy_manage');
    const denied = await pool.query(
      `select outcome from audit.events where action = 'privacy.request' and actor_id = $1`,
      [bob.id],
    );
    expect(denied.rows).toEqual([{ outcome: 'denied' }]);
    expect((await file(carol, 'export', { for: { email: 'nobody@nowhere.test' } })).status).toBe(
      404,
    );
    expect((await file(carol, 'export', { for: { userId: ravi.id } })).status).toBe(404);
    const byTeam = await file(carol, 'export', {
      for: { email: dee.email },
      intake: 'email',
      note: 'By email',
    });
    expect(byTeam.status).toBe(200);
    expect(byTeam.body.value).toMatchObject({
      status: 'in_progress',
      intake: 'email',
      subject: { kind: 'user', id: dee.id },
      requestedBy: { kind: 'user', id: carol.id },
      note: 'By email',
    });
    expect((await finished(carol, byTeam.body.value.id)).status).toBe('completed');
  });

  it("never erases the business's default owner", async () => {
    const res = await file(ana, 'erase');
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('default_owner');
  });
});

describe('being forgotten', () => {
  let contact = { contactId: '', customerId: '' };

  it('deletes, keeps and blanks as each module declares, and redacts the copies', async () => {
    const [card] = (await call(cy, 'GET', '/api/cards')).body.items;
    expect(
      (await call(cy, 'PATCH', `/api/cards/${card.id}`, { name: 'Cy renamed', phone: '+91 1' }))
        .status,
    ).toBe(200);
    const caller = (
      await call(cy, 'POST', '/api/callers', { caller: 'Cy calling', phone: '+91 2' })
    ).body.value;
    const deeCard = (await call(dee, 'GET', '/api/cards')).body.items[0];
    const cyCards = (
      await pool.query('select id from app.fixture_ledgers_cards where customer_id = $1', [
        customer[cy.name],
      ])
    ).rows.map((r) => r.id);
    const runs = (
      await pool.query(
        `select distinct m.run_id from app.thread_messages m join app.threads t on t.id = m.thread_id
         where t.owner_id = $1 and m.run_id is not null`,
        [cy.id],
      )
    ).rows.map((r) => r.run_id as string);
    expect(runs.length).toBeGreaterThan(0);
    // A trace of one of their runs, when Mastra has made its tables here.
    const traced =
      (await mastraSpans()) &&
      (await pool
        .query(
          `insert into mastra_obs.mastra_span_events ("traceId", "spanId", name, "spanType",
             "isEvent", "isPending", "startedAt", "endedAt", tags, "metadataSearch", "runId",
             "userId")
           values ($1, $2, 'agent run', 'agent_run', false, false, now(), now(), '{}', '{}', $1, $3)`,
          [runs[0], `s${Date.now()}`, cy.id],
        )
        .then(() => true)
        .catch(() => false));

    const res = await file(cy, 'erase');
    expect(res.status).toBe(200);
    const done = await finished(ana, res.body.value.id);
    expect(done.status).toBe('completed');
    expect(done.outcome).toMatchObject({
      records: {
        cards: { deleted: 2 },
        ledgerEntries: { kept: 1, keepReason: 'legal_hold' },
        callers: { anonymised: 1 },
      },
      framework: { threads: 1, memberships: 1, customers: 1 },
      account: true,
    });

    // Cards gone; the entry kept as it was; the caller blanked; Dee's card untouched.
    expect(
      (await pool.query('select id from app.fixture_ledgers_cards where id = any($1)', [cyCards]))
        .rows,
    ).toEqual([]);
    expect(
      (
        await pool.query('select payer from app.fixture_ledgers_entries where customer_id = $1', [
          customer[cy.name],
        ])
      ).rows,
    ).toEqual([{ payer: 'Cy Payer' }]);
    expect(
      (
        await pool.query('select caller, phone from app.fixture_ledgers_callers where id = $1', [
          caller.id,
        ])
      ).rows,
    ).toEqual([{ caller: 'erased', phone: null }]);
    expect((await call(ana, 'GET', `/api/cards/${deeCard.id}`)).body.name).toBe('Dee card');

    // The audit trail keeps every row, without the personal fields.
    const trail = await pool.query(
      `select action, before, after from audit.events where resource_type = 'card' and resource_id = $1 order by at`,
      [card.id],
    );
    expect(trail.rows.map((r) => r.action)).toEqual(['card.create', 'card.update']);
    for (const r of trail.rows)
      for (const copy of [r.before, r.after].filter(Boolean)) {
        expect(copy).not.toHaveProperty('name');
        expect(copy).not.toHaveProperty('phone');
        expect(copy).toHaveProperty('amountMinor', 700);
      }
    const events = await pool.query(
      `select "row", before from app.domain_events where resource_type = 'card' and resource_id = $1`,
      [card.id],
    );
    expect(events.rows.length).toBeGreaterThan(0);
    for (const e of events.rows) {
      expect(e.row).not.toHaveProperty('name');
      if (e.before) expect(e.before).not.toHaveProperty('phone');
    }

    // The membership, the thread and the account are gone; the session no longer works.
    expect(
      (await pool.query('select 1 from app.memberships where user_id = $1', [cy.id])).rows,
    ).toEqual([]);
    expect(
      (await pool.query('select 1 from app.threads where owner_id = $1', [cy.id])).rows,
    ).toEqual([]);
    const account = (
      await pool.query('select name, email from public."user" where id = $1', [cy.id])
    ).rows[0];
    expect(account).toEqual({ name: '', email: `erased-${cy.id}@erased.invalid` });
    expect(
      (await pool.query('select 1 from public.session where user_id = $1', [cy.id])).rows,
    ).toEqual([]);
    expect((await cy.call('GET', '/api/me')).status).toBe(401);
    expect(
      (
        await pool.query('select display_name, user_id from app.customers where id = $1', [
          customer[cy.name],
        ])
      ).rows,
    ).toEqual([{ display_name: 'Erased customer', user_id: null }]);
    if (traced)
      expect(
        (
          await pool.query('select 1 from mastra_obs.mastra_span_events where "runId" = any($1)', [
            runs,
          ])
        ).rows,
      ).toEqual([]);

    // Their earlier export stays as evidence, without its archive.
    const earlier = (await call(ana, 'GET', '/api/privacy/requests?kind=export')).body.items.find(
      (r: Json) => r.subject.id === cy.id,
    );
    expect(earlier).toMatchObject({ status: 'completed', files: [] });
    expect(await auditOf('privacy.erased', done.id)).toMatchObject([{ actor_kind: 'system' }]);
  });

  it('forgets a WhatsApp contact the privacy team files for', async () => {
    contact = await seedContact(tenantId, 'Gita Privacy', '919800000077');
    const caller = (
      await call(ana, 'POST', '/api/callers', {
        caller: 'Gita',
        phone: '919800000077',
        contactId: contact.contactId,
      })
    ).body.value;
    const res = await file(carol, 'erase', { for: { address: '+919800000077' }, intake: 'phone' });
    expect(res.status).toBe(200);
    expect(res.body.value.subject).toEqual({ kind: 'contact', id: contact.contactId });
    const done = await finished(carol, res.body.value.id);
    expect(done.outcome).toMatchObject({
      records: { callers: { anonymised: 1 } },
      framework: { contacts: 1 },
    });
    expect(
      (await pool.query('select 1 from channel.contacts where id = $1', [contact.contactId])).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query('select caller from app.fixture_ledgers_callers where id = $1', [
          caller.id,
        ])
      ).rows,
    ).toEqual([{ caller: 'erased' }]);
    expect(
      (
        await pool.query(
          `select 1 from audit.events where action = 'channel.contact.erased' and resource_id = $1`,
          [contact.contactId],
        )
      ).rows,
    ).toHaveLength(1);
  });
});

describe('a business that reviews requests', () => {
  it('makes a person wait, parks processing an erasure for an approval, then carries it out', async () => {
    await setTenantSettings(tenantId, { privacy: { review: ['erase'] } });
    const res = await file(dee, 'erase');
    expect(res.status).toBe(200);
    const req = res.body.value;
    expect(req.status).toBe('received');
    expect((await file(dee, 'erase')).status).toBe(409);
    // Dee may not process it herself.
    expect((await call(dee, 'POST', `/api/privacy/requests/${req.id}/process`, {})).status).toBe(
      403,
    );

    const parked = await call(carol, 'POST', `/api/privacy/requests/${req.id}/process`, {});
    expect(parked.status).toBe(200);
    expect(parked.body.status).toBe('needs_approval');
    // Dee's refusal, then Carol's park.
    expect(await auditOf('privacy.process', req.id)).toMatchObject([
      { outcome: 'denied', rule: 'needs_privacy_manage' },
      { outcome: 'needs_approval' },
    ]);
    expect((await call(dee, 'GET', `/api/privacy/requests/${req.id}`)).body.status).toBe(
      'received',
    );

    const approved = await call(ana, 'POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const done = await finished(ana, req.id);
    expect(done.status).toBe('completed');
    expect(done.outcome).toMatchObject({ records: { cards: { deleted: 1 } } });
  });

  it('refuses a request that waits, saying why', async () => {
    await setTenantSettings(tenantId, { privacy: { review: ['export'] } });
    const req = (await file(bob, 'export')).body.value;
    expect(req.status).toBe('received');
    expect((await call(carol, 'POST', `/api/privacy/requests/${req.id}/refuse`, {})).status).toBe(
      400,
    );
    expect(
      (await call(bob, 'POST', `/api/privacy/requests/${req.id}/refuse`, { reason: 'no' })).status,
    ).toBe(403);
    const refused = await call(carol, 'POST', `/api/privacy/requests/${req.id}/refuse`, {
      reason: 'We could not confirm who asked',
    });
    expect(refused.body.value).toMatchObject({
      status: 'refused',
      reason: 'We could not confirm who asked',
    });
    expect(await auditOf('privacy.refuse', req.id)).toMatchObject([
      { outcome: 'denied' },
      { outcome: 'committed', actor_kind: 'user' },
    ]);
    expect((await call(carol, 'POST', `/api/privacy/requests/${req.id}/process`, {})).status).toBe(
      409,
    );
  });
});

describe('deadlines', () => {
  it("follow the business's setting, and a request past due is marked once", async () => {
    await setTenantSettings(tenantId, { privacy: { review: ['export'], respondWithinDays: 2 } });
    const req = (await file(bob, 'export')).body.value;
    expect(Date.parse(req.dueAt) - Date.parse(req.receivedAt)).toBe(2 * 86_400_000);
    const later = new Date(Date.now() + 3 * 86_400_000);
    expect((await privacy().sweepOverdue(later)).overdue).toBeGreaterThanOrEqual(1);
    expect((await call(bob, 'GET', `/api/privacy/requests/${req.id}`)).body.overdueAt).toBe(
      later.toISOString(),
    );
    const events = await pool.query(
      `select name from app.domain_events where resource_type = 'privacyRequest' and resource_id = $1`,
      [req.id],
    );
    expect(events.rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(['privacy.request.received', 'privacy.request.overdue']),
    );
    await privacy().sweepOverdue(later);
    expect(
      (
        await pool.query(
          `select count(*)::int as n from audit.events where action = 'privacy.overdue' and resource_id = $1`,
          [req.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});

describe('retention', () => {
  const age = (id: string, days: number) =>
    pool.query(
      `update app.fixture_ledgers_cards set created_at = now() - make_interval(days => $2) where id = $1`,
      [id, days],
    );

  it("deletes someone's records after their period, per business, and redacts their copies", async () => {
    await setTenantSettings(tenantId, { privacy: null });
    const old = (await call(eve, 'POST', '/api/cards', { name: 'Eve old', amountMinor: 1 })).body
      .value;
    const recent = (await call(eve, 'POST', '/api/cards', { name: 'Eve recent' })).body.value;
    // Ana's own card is nobody's personal data: no retention.
    const anas = (await call(ana, 'POST', '/api/cards', { name: 'Ana own' })).body.value;
    await age(old.id, 40);
    await age(anas.id, 40);
    expect(await privacy().runRetention({ tenantId })).toMatchObject({ 'ledgers.cards': 1 });
    const left = await pool.query('select id from app.fixture_ledgers_cards where id = any($1)', [
      [old.id, recent.id, anas.id],
    ]);
    expect(left.rows.map((r) => r.id).sort()).toEqual([recent.id, anas.id].sort());
    const trail = await pool.query(
      `select after from audit.events where resource_type = 'card' and resource_id = $1`,
      [old.id],
    );
    expect(trail.rows[0].after).not.toHaveProperty('name');
    const applied = await pool.query(
      `select after from audit.events where action = 'privacy.retention.applied' and resource_id = $1
       order by at desc limit 1`,
      [tenantId],
    );
    expect(applied.rows[0].after).toMatchObject({ target: 'ledgers.cards', days: 30, count: 1 });
    // Nothing due: nothing is audited.
    const before = (
      await pool.query(
        `select count(*)::int as n from audit.events where action = 'privacy.retention.applied'`,
      )
    ).rows[0].n;
    await privacy().runRetention({ tenantId });
    expect(
      (
        await pool.query(
          `select count(*)::int as n from audit.events where action = 'privacy.retention.applied'`,
        )
      ).rows[0].n,
    ).toBe(before);
  });

  it("follows the business's own period, or keeps the data when it says so", async () => {
    const card = (await call(eve, 'POST', '/api/cards', { name: 'Eve kept' })).body.value;
    await age(card.id, 40);
    await setTenantSettings(tenantId, { privacy: { retention: { 'ledgers.cards': null } } });
    expect(await privacy().runRetention({ tenantId })).not.toHaveProperty('ledgers.cards');
    await setTenantSettings(tenantId, { privacy: { retention: { 'ledgers.cards': 60 } } });
    expect(await privacy().runRetention({ tenantId })).not.toHaveProperty('ledgers.cards');
    await setTenantSettings(tenantId, { privacy: { retention: { 'ledgers.cards': 10 } } });
    expect(await privacy().runRetention({ tenantId })).toMatchObject({ 'ledgers.cards': 1 });
  });

  it("runs a framework target only with the application's period", async () => {
    await pool.query(
      `insert into app.outbox (tenant_id, key, payload, created_at, relayed_at)
       values ($1, 'fixture.old', '{}', now() - interval '3 days', now() - interval '3 days')`,
      [tenantId],
    );
    const ran = await privacy().runRetention({ tenantId });
    expect(ran['outbox.relayed']).toBeGreaterThanOrEqual(1);
    expect(ran).not.toHaveProperty('chat.messages');
    expect(
      (
        await pool.query(`select 1 from app.outbox where tenant_id = $1 and key = 'fixture.old'`, [
          tenantId,
        ])
      ).rows,
    ).toEqual([]);
  });
});

describe('the register', () => {
  it('names the business, its processors, its personal data and its periods', async () => {
    await setTenantSettings(tenantId, {
      privacy: {
        respondWithinDays: 15,
        retention: { 'ledgers.cards': 45 },
        processors: [{ name: 'Our accountant', purpose: 'Keeps the books', data: ['names'] }],
      },
    });
    const res = await call(bob, 'GET', '/api/privacy/register');
    expect(res.status).toBe(200);
    const reg = res.body;
    expect(reg.fiduciary).toMatchObject({ tenantId });
    expect(reg.requests).toEqual({ respondWithinDays: 15, review: [] });
    expect(reg.processors).toEqual([
      expect.objectContaining({
        name: 'Fixture mail',
        source: 'application',
        location: 'Test region',
      }),
      expect.objectContaining({
        name: 'Our accountant',
        source: 'business',
        purpose: 'Keeps the books',
      }),
    ]);
    expect(reg.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: 'card',
          module: 'ledgers',
          erase: 'delete',
          retention: 'ledgers.cards',
          purpose: 'Cards the business keeps about its customers',
          fields: [
            { name: 'name', label: 'Name' },
            { name: 'phone', label: 'Phone' },
          ],
        }),
        expect.objectContaining({ entity: 'ledgerEntry', erase: 'keep', keepReason: 'legal_hold' }),
        expect.objectContaining({ entity: 'caller', erase: 'anonymise' }),
      ]),
    );
    const period = (name: string) => reg.retention.find((r: Json) => r.name === name);
    expect(period('ledgers.cards')).toMatchObject({ days: 45, scope: 'tenant' });
    expect(period('outbox.relayed')).toMatchObject({ days: 1 });
    expect(period('chat.messages')).toMatchObject({ days: null });
    expect(period('assistant.traces')).toMatchObject({ scope: 'deployment', days: null });
    // Another business reads its own.
    const theirs = await ravi.call('GET', '/api/privacy/register', undefined, {
      'x-tenant-id': raviTenant,
    });
    expect(theirs.body.fiduciary.tenantId).toBe(raviTenant);
    expect(theirs.body.processors.map((p: Json) => p.name)).toEqual(['Fixture mail']);
  });
});
