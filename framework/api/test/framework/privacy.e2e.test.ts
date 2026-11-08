// Personal data (B18), against the fixture's `ledgers` module (fixture/src/features/privacy):
// cards deleted when their customer is forgotten (and after 30 days), ledger entries kept for a
// legal hold, callers anonymised. A customer asks for a copy and gets their personal data only;
// another business, the team without `privacy.manage` and the assistant reach neither the
// request nor the archive; erasure deletes, keeps and blanks as declared, redacts the copies the
// server keeps, and forgets the account; a business that reviews erasures makes them wait, and
// processing one parks for an approval; an erasure the team files that waits for an approval
// leaves no email, number or note behind; deadlines are marked once; retention runs per business
// with its own periods; the register lists who holds what; the business's privacy team changes
// its own settings, audited, and the register and the runner follow them. The later features'
// tables (calendars, calls, the integration bus, acceptance, MCP grants) are exported and erased
// too, and another business's rows stay as they were (decisions H4).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrivacyService, readZip } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  connectMcp,
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
import { erasedAfterCommit, privacyApp } from '../fixture/dist/features/privacy/index.js';

const ana = new Person('Ana Privacy'); // owner of the business
const bob = new Person('Bob Privacy'); // staff
const carol = new Person('Carol Privacy'); // admin: handles privacy requests
const cy = new Person('Cy Privacy'); // a customer, forgotten in the end
const dee = new Person('Dee Privacy'); // a customer whose erasure is reviewed
const eve = new Person('Eve Privacy'); // a customer whose cards expire
const fay = new Person('Fay Privacy'); // a customer whose erasure the team files from a letter
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
  for (const p of [ana, bob, carol, cy, dee, eve, fay, ravi]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  raviTenant = (await me(ravi)).tenantId;
  await addMember(bob, tenantId, ['staff']);
  await addMember(carol, tenantId, ['admin']);
  for (const p of [cy, dee, eve, fay]) customer[p.name] = await makeCustomer(p);
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
    // The team's note is the team's.
    expect(
      (await call(dee, 'GET', `/api/privacy/requests/${byTeam.body.value.id}`)).body,
    ).toMatchObject({ status: 'completed', note: null });
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

/**
 * Rows of this business's approvals, audit trail, stored events, notifications and kept replies
 * whose text holds any of these.
 */
async function copiesHolding(...texts: string[]) {
  const like = texts.map((t) => `%${t.toLowerCase()}%`);
  return (
    await pool.query(
      `select 'approval' as at, id::text as id from app.approvals
         where tenant_id = $1 and lower(payload::text || coalesce(summary, '')) like any($2)
       union all
       select 'audit', id from audit.events
         where tenant_id = $1
           and lower(coalesce(before::text, '') || coalesce(after::text, '')) like any($2)
       union all
       select 'event', id::text from app.domain_events
         where tenant_id = $1
           and lower(coalesce("row"::text, '') || coalesce(before::text, '')) like any($2)
       union all
       select 'outbox', id::text from app.outbox
         where tenant_id = $1 and lower(payload::text) like any($2)
       union all
       select 'reply', key from app.idempotency
         where split_part(principal_id, ':', 3) = $1 and lower(response::text) like any($2)`,
      [tenantId, like],
    )
  ).rows;
}

describe('an erasure the team files from a letter', () => {
  /** The completed erasure of this subject, as the privacy team lists it. */
  const erased = (subjectId: string) =>
    eventually(async () => {
      const list = await call(carol, 'GET', '/api/privacy/requests?kind=erase');
      return list.body.items.find(
        (r: Json) => r.subject.id === subjectId && ['completed', 'failed'].includes(r.status),
      );
    }, 20_000);

  it('waits for an approval, and leaves no email or note behind', async () => {
    await setTenantSettings(tenantId, { privacy: null });
    await call(fay, 'POST', '/api/cards', { name: 'Fay card' });
    const note = 'Letter of the third, from flat 4B';
    // As the back office files it: with a key, so its reply is kept for a retry.
    const res = await carol.call(
      'POST',
      '/api/privacy/requests',
      { kind: 'erase', for: { email: fay.email.toUpperCase() }, intake: 'post', note },
      here({ 'idempotency-key': `fay-${fay.id}` }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('needs_approval');
    const approvalId = res.body.approval.id;
    // The approval names Fay by id, never by the email she was filed with.
    const parked = await pool.query('select payload from app.approvals where id = $1', [
      approvalId,
    ]);
    expect(parked.rows[0].payload.input.for).toEqual({ userId: fay.id });
    expect(parked.rows[0].payload.input.note).toBe(note);

    const approved = await call(ana, 'POST', `/api/approvals/${approvalId}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const done = await erased(fay.id);
    expect(done).toMatchObject({ status: 'completed', intake: 'post', note: null });
    expect(done.outcome).toMatchObject({
      records: { cards: { deleted: 1 } },
      account: true,
      redacted: {
        approvals: expect.any(Number),
        audit: expect.any(Number),
        replies: expect.any(Number),
      },
    });
    expect(done.outcome.redacted.approvals).toBeGreaterThanOrEqual(1);
    expect(done.outcome.redacted.audit).toBeGreaterThanOrEqual(1);
    expect(done.outcome.redacted.replies).toBeGreaterThanOrEqual(1);
    expect(await copiesHolding(fay.email, note)).toEqual([]);
    // The trail still says whom it was for, by id, and who approved it.
    const trail = await pool.query(
      `select after from audit.events where action = 'approval.approved' and resource_id = $1`,
      [approvalId],
    );
    expect(trail.rows[0].after.payload.input).toEqual({
      kind: 'erase',
      for: { userId: fay.id },
      intake: 'post',
    });
  });

  it('waits for an approval, and leaves no WhatsApp number or note behind', async () => {
    const number = '919800000088';
    const hari = await seedContact(tenantId, 'Hari Privacy', number);
    await call(ana, 'POST', '/api/callers', {
      caller: 'Hari',
      phone: number,
      contactId: hari.contactId,
    });
    const note = 'Hari wrote in, letter kept in the file';
    const res = await carol.call(
      'POST',
      '/api/privacy/requests',
      { kind: 'erase', for: { address: `+${number}` }, intake: 'post', note },
      here({ 'idempotency-key': `hari-${hari.contactId}` }),
    );
    expect(res.body.status).toBe('needs_approval');
    expect(
      (await pool.query('select payload from app.approvals where id = $1', [res.body.approval.id]))
        .rows[0].payload.input.for,
    ).toEqual({ contactId: hari.contactId });
    const approved = await call(ana, 'POST', `/api/approvals/${res.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const done = await erased(hari.contactId);
    expect(done).toMatchObject({ status: 'completed', subject: { kind: 'contact' } });
    expect(done.outcome).toMatchObject({ records: { callers: { anonymised: 1 } } });
    expect(await copiesHolding(number, note)).toEqual([]);
  });
});

describe("the business's own privacy settings", () => {
  const age = (id: string, days: number) =>
    pool.query(
      `update app.fixture_ledgers_cards set created_at = now() - make_interval(days => $2) where id = $1`,
      [id, days],
    );
  const patch = {
    respondWithinDays: 12,
    review: ['erase'],
    retention: { 'ledgers.cards': 5, 'outbox.relayed': null },
    processors: [{ name: 'Our printer', purpose: 'Prints the letters', data: ['addresses'] }],
    grievanceContact: 'privacy-desk@fixture.test',
    privacyUrl: 'https://fixture.test/privacy',
  };
  const stored = async (id: string) =>
    (await pool.query('select settings from app.tenants where id = $1', [id])).rows[0].settings;

  it('are changed by its privacy team only, audited, and only in its own business', async () => {
    await setTenantSettings(tenantId, { privacy: null, grievanceContact: null, privacyUrl: null });
    const theirsBefore = await stored(raviTenant);

    // Staff without privacy.manage neither read nor change them; nor does the assistant.
    const refused = await call(bob, 'PATCH', '/api/privacy/settings', patch);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'needs_privacy_manage' });
    expect((await call(bob, 'GET', '/api/privacy/settings')).status).toBe(403);
    const assistant = asAssistant(`user:${carol.id}`, { 'x-tenant-id': tenantId });
    expect((await assistant('PATCH', '/api/privacy/settings', patch)).status).toBe(403);
    expect((await assistant('GET', '/api/privacy/settings')).status).toBe(403);
    // Another business's owner does not reach this one.
    expect((await ravi.call('PATCH', '/api/privacy/settings', patch, here())).status).not.toBe(200);
    expect(await stored(tenantId)).not.toHaveProperty('grievanceContact');

    const res = await call(carol, 'PATCH', '/api/privacy/settings', patch);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', value: patch });
    expect((await call(carol, 'GET', '/api/privacy/settings')).body).toEqual(res.body.value);
    const mine = await stored(tenantId);
    expect(mine).toMatchObject({
      grievanceContact: patch.grievanceContact,
      privacyUrl: patch.privacyUrl,
      privacy: { respondWithinDays: 12, review: ['erase'], retention: patch.retention },
    });
    // Ravi's business is as it was, and its register still its own.
    expect(await stored(raviTenant)).toEqual(theirsBefore);
    const theirs = await ravi.call('GET', '/api/privacy/register', undefined, {
      'x-tenant-id': raviTenant,
    });
    expect(theirs.body.fiduciary.grievanceContact).not.toBe(patch.grievanceContact);
    expect(theirs.body.processors.map((p: Json) => p.name)).toEqual(['Fixture mail']);

    // Audited: Bob's refusal, Carol's change with the business before and after.
    const trail = await pool.query(
      `select action, outcome, actor_id, before, after from audit.events
       where tenant_id = $1 and resource_type = 'tenant' and resource_id = $1
         and action in ('privacy.configure', 'tenant.update')
       order by at`,
      [tenantId],
    );
    expect(trail.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'privacy.configure', outcome: 'denied' }),
        expect.objectContaining({
          action: 'privacy.configure',
          outcome: 'committed',
          actor_id: carol.id,
        }),
        expect.objectContaining({
          action: 'tenant.update',
          after: expect.objectContaining({
            grievanceContact: patch.grievanceContact,
            privacy: expect.objectContaining({ respondWithinDays: 12 }),
          }),
        }),
      ]),
    );
    // Every process drops its cached copy.
    const changed = await pool.query(
      `select "row" from app.domain_events where name = 'settings.changed' and resource_id = $1`,
      [tenantId],
    );
    expect(changed.rows.map((r) => r.row.section)).toContain('privacy');
  });

  it('are what the register, the deadline and the retention runner follow', async () => {
    const reg = (await call(bob, 'GET', '/api/privacy/register')).body;
    expect(reg.fiduciary).toMatchObject({
      grievanceContact: patch.grievanceContact,
      privacyUrl: patch.privacyUrl,
    });
    expect(reg.requests).toEqual({ respondWithinDays: 12, review: ['erase'] });
    expect(reg.processors.map((p: Json) => [p.name, p.source])).toEqual([
      ['Fixture mail', 'application'],
      ['Our printer', 'business'],
    ]);
    const period = (name: string) => reg.retention.find((r: Json) => r.name === name);
    expect(period('ledgers.cards')).toMatchObject({ days: 5, defaultDays: 30 });
    expect(period('outbox.relayed')).toMatchObject({ days: null, defaultDays: 1 });

    const req = (await file(eve, 'export')).body.value;
    expect(Date.parse(req.dueAt) - Date.parse(req.receivedAt)).toBe(12 * 86_400_000);
    await finished(eve, req.id);

    // A week-old card goes with the business's 5 days (the application's 30 would keep it);
    // an old relayed notification stays, as the business keeps them.
    const card = (await call(eve, 'POST', '/api/cards', { name: 'Eve, a week ago' })).body.value;
    await age(card.id, 7);
    await pool.query(
      `insert into app.outbox (tenant_id, key, payload, created_at, relayed_at)
       values ($1, 'fixture.kept', '{}', now() - interval '3 days', now() - interval '3 days')`,
      [tenantId],
    );
    const ran = await privacy().runRetention({ tenantId });
    expect(ran).toMatchObject({ 'ledgers.cards': 1 });
    expect(ran).not.toHaveProperty('outbox.relayed');
    expect(
      (await pool.query('select 1 from app.fixture_ledgers_cards where id = $1', [card.id])).rows,
    ).toEqual([]);
  });

  it('refuse a period nothing has or the deployment keeps, and go back to the defaults with null', async () => {
    const bad = await call(carol, 'PATCH', '/api/privacy/settings', {
      retention: { 'no.such.rule': 3, 'assistant.traces': 3 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'privacy_settings_invalid' });
    expect(bad.body.problems).toHaveLength(2);
    expect(
      (await call(carol, 'PATCH', '/api/privacy/settings', { respondWithinDays: 0 })).status,
    ).toBe(400);
    expect(
      (
        await call(carol, 'PATCH', '/api/privacy/settings', {
          processors: [patch.processors[0], patch.processors[0]],
        })
      ).status,
    ).toBe(400);

    const back = await call(carol, 'PATCH', '/api/privacy/settings', {
      respondWithinDays: null,
      grievanceContact: null,
      privacyUrl: null,
    });
    expect(back.status).toBe(200);
    expect(back.body.value).toMatchObject({
      respondWithinDays: null,
      privacyUrl: null,
      review: ['erase'],
      processors: [expect.objectContaining({ name: 'Our printer' })],
    });
    expect(back.body.value.grievanceContact).not.toBe(patch.grievanceContact);
    const mine = await stored(tenantId);
    expect(mine).not.toHaveProperty('grievanceContact');
    expect(mine).not.toHaveProperty('privacyUrl');
    expect(mine.privacy).not.toHaveProperty('respondWithinDays');
    // The application's deadline again.
    expect((await call(bob, 'GET', '/api/privacy/register')).body.requests.respondWithinDays).toBe(
      30,
    );
  });
});

describe("the later features' personal data", () => {
  const hal = new Person('Hal Privacy'); // a customer with everything, forgotten
  const ian = new Person('Ian Privacy'); // staff here, owner of his own business
  const HAL_NUMBER = '919800000101';
  const OTHER_LINE = '+918000000001';
  let ianTenant = '';
  let contactId = '';
  let cardId = '';
  const rows: Record<string, string> = {};
  const mcp: Record<string, Awaited<ReturnType<typeof connectMcp>>> = {};

  const one = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0];
  const id = async (sql: string, params: unknown[]) => (await one(sql, params)).id as string;
  /** The REST API with a bearer token, as an MCP client calls it. */
  const withToken = async (token: string, path: string, tenant?: string) =>
    (
      await fetch(`${server.base}${path}`, {
        headers: { authorization: `Bearer ${token}`, ...(tenant ? { 'x-tenant-id': tenant } : {}) },
      })
    ).status;
  const logCall = async (p: Person, tenant: string, body: Json) => {
    const res = await p.call('POST', '/api/calls', body, { 'x-tenant-id': tenant });
    expect(res.status).toBeLessThan(300);
    return res.body.value.id as string;
  };
  const webhookBody = (resourceType: string, resourceId: string, row: Json) =>
    JSON.stringify({
      type: `${resourceType}.created`,
      timestamp: new Date().toISOString(),
      data: { eventId: 'e1', tenantId, resourceType, resourceId, row },
    });

  beforeAll(async () => {
    await setTenantSettings(tenantId, { privacy: null });
    for (const p of [hal, ian]) await p.signUp();
    ianTenant = (await me(ian)).tenantId;
    customer[hal.name] = await makeCustomer(hal);
    await addMember(ian, tenantId, ['staff']);
    // Hal's WhatsApp number is linked to his account here.
    contactId = (await seedContact(tenantId, 'Hal Privacy', HAL_NUMBER)).contactId;
    await pool.query('update channel.contacts set user_id = $1 where id = $2', [hal.id, contactId]);
    cardId = (
      await call(hal, 'POST', '/api/cards', {
        name: 'Hal card',
        phone: '+91 90000 00101',
        amountMinor: 300,
      })
    ).body.value.id;
    const halEmail = hal.email;

    // Calendars: a connection (its event link, its push channel's inbound connection and event),
    // a feed, a sign-in under way, an invite to his email; in Ravi's business, one too.
    rows.calendarInbound = await id(
      `insert into app.integration_connections (tenant_id, connector, credentials_sealed)
       values ($1, 'fixture-calendar', 'sealed') returning id`,
      [tenantId],
    );
    await pool.query(
      `insert into app.integration_inbound (tenant_id, connection_id, connector, external_id, type, data)
       values ($1, $2, 'fixture-calendar', 'ch1', 'calendar.changed', '{"channelId":"ch1"}')`,
      [tenantId, rows.calendarInbound],
    );
    rows.connection = await id(
      `insert into app.calendar_connections (tenant_id, user_id, provider, account, tokens_sealed,
         inbound_connection_id)
       values ($1, $2, 'google', $3, 'not-a-sealed-value', $4) returning id`,
      [tenantId, hal.id, halEmail, rows.calendarInbound],
    );
    await pool.query(
      `insert into app.calendar_event_links (tenant_id, connection_id, resource_type, resource_id, external_id)
       values ($1, $2, 'card', $3, 'google-event-1')`,
      [tenantId, rows.connection, cardId],
    );
    await pool.query(
      `insert into app.calendar_feeds (tenant_id, user_id, label, token_hash)
       values ($1, $2, 'Hal phone', md5(random()::text) || md5(random()::text))`,
      [tenantId, hal.id],
    );
    await pool.query(
      `insert into app.calendar_oauth_states (tenant_id, user_id, provider, state_hash,
         verifier_sealed, return_to, expires_at)
       values ($1, $2, 'google', md5(random()::text), 'sealed', 'http://localhost/back',
         now() + interval '10 minutes')`,
      [tenantId, hal.id],
    );
    for (const t of [tenantId, raviTenant])
      await pool.query(
        `insert into app.calendar_invites (tenant_id, resource_type, resource_id, email, name)
         values ($1, 'card', $2, $3, 'Hal P')`,
        [t, cardId, t === tenantId ? halEmail.toUpperCase() : halEmail],
      );

    // Calls with his number, here and in Ravi's business.
    rows.callIn = await logCall(ana, tenantId, {
      direction: 'inbound',
      from: `+${HAL_NUMBER}`,
      to: OTHER_LINE,
      notes: 'Hal asked about the delivery',
    });
    rows.callOut = await logCall(ana, tenantId, {
      direction: 'outbound',
      from: OTHER_LINE,
      to: `+${HAL_NUMBER}`,
      notes: 'Rang Hal back',
    });
    rows.callElsewhere = await logCall(ravi, raviTenant, {
      direction: 'inbound',
      from: `+${HAL_NUMBER}`,
      notes: 'Another business',
    });

    // The bus: his card delivered (with a try the receiver answered), a record naming his
    // number delivered, an inbound event whose handler wrote his card, and one naming his email;
    // in Ravi's business, a delivery and an inbound event naming him too.
    for (const t of [tenantId, raviTenant]) {
      const endpoint = await id(
        `insert into app.integration_endpoints (tenant_id, url, events, secret_sealed)
         values ($1, 'https://receiver.test/hook', '{*}', 'sealed') returning id`,
        [t],
      );
      const hooks = await id(
        `insert into app.integration_connections (tenant_id, connector, credentials_sealed)
         values ($1, 'fixture-hooks', 'sealed') returning id`,
        [t],
      );
      const deliver = (type: string, rid: string, row: Json) =>
        id(
          `insert into app.integration_deliveries (tenant_id, endpoint_id, event_id, event_name,
             resource_type, resource_id, body, status)
           values ($1, $2, gen_random_uuid()::text, $3, $4, $5, $6, 'delivered') returning id`,
          [t, endpoint, `${type}.created`, type, rid, webhookBody(type, rid, row)],
        );
      const receive = (externalId: string, data: Json) =>
        id(
          `insert into app.integration_inbound (tenant_id, connection_id, connector, external_id,
             type, data, status)
           values ($1, $2, 'fixture-hooks', $3, 'fixture.event', $4, 'processed') returning id`,
          [t, hooks, externalId, JSON.stringify(data)],
        );
      const naming = {
        id: 'r1',
        title: 'Ring back',
        phone: `+${HAL_NUMBER}`,
        note: `Ring +${HAL_NUMBER} later`,
      };
      const mail = { attendee: { email: halEmail.toUpperCase(), name: 'Hal' }, text: halEmail };
      if (t === raviTenant) {
        rows.otherDelivery = await deliver('task', 'r1', naming);
        rows.otherInbound = await receive('mail', mail);
        continue;
      }
      rows.cardDelivery = await deliver('card', cardId, {
        id: cardId,
        name: 'Hal card',
        phone: '+91 90000 00101',
        amountMinor: 300,
      });
      await pool.query(
        `insert into app.integration_attempts (tenant_id, delivery_id, attempt, url, status, response)
         values ($1, $2, 1, 'https://receiver.test/hook', 200, '{"got":"Hal card"}')`,
        [t, rows.cardDelivery],
      );
      rows.namingDelivery = await deliver('task', 'r1', naming);
      rows.wroteCard = await receive('card', { card: { name: 'Hal card' } });
      await pool.query(
        `insert into audit.events (action, resource_type, resource_id, actor_kind, actor_id,
           tenant_id, request_id)
         values ('card.update', 'card', $1, 'system', 'integrations.fixture-hooks', $2, $3)`,
        [cardId, t, `inbound-${rows.wroteCard}`],
      );
      rows.mailInbound = await receive('mail', mail);
    }

    // Acceptance: evidence he signed, and codes sent to him (here and in Ravi's business).
    await pool.query(
      `insert into audit.acceptances (id, tenant_id, seq, name, method, resource_type, resource_id,
         document_id, document_name, document_version, document_sha256, document_file_name,
         statement, lang, signer_kind, signer_user_id, signer_name, otp_channel, otp_address, ip,
         user_agent, accepted_at, hash)
       values (gen_random_uuid()::text, $1, 1, 'fixture.terms', 'otp', 'card', $2, 'doc-1',
         'fixture.terms', 1, 'abc123', 'terms.pdf', 'I agree', 'en', 'user', $3, 'Hal Privacy',
         'email', $4, '203.0.113.5', 'Fixture agent', now(), 'h1')`,
      [tenantId, cardId, hal.id, halEmail],
    );
    const code = (t: string, userId: string | null, channel: string, address: string) =>
      pool.query(
        `insert into channel.otp_challenges (tenant_id, purpose, user_id, channel, address,
           code_hash, expires_at)
         values ($1, 'acceptance', $2, $3, $4, 'hash-never-exported', now() + interval '10 minutes')`,
        [t, userId, channel, address],
      );
    await code(tenantId, hal.id, 'email', halEmail);
    await code(tenantId, null, 'email', halEmail.toUpperCase());
    await code(raviTenant, null, 'email', halEmail);

    // MCP: Hal's client here; Ian's here and in his own business.
    mcp.hal = await connectMcp(hal, 'ledgers:read');
    expect((await ian.call('PUT', '/api/me/default', { tenantId })).status).toBe(200);
    mcp.ianHere = await connectMcp(ian, 'ledgers:read');
    expect((await ian.call('PUT', '/api/me/default', { tenantId: ianTenant })).status).toBe(200);
    mcp.ianOwn = await connectMcp(ian, 'ledgers:read');
    // Ian's calls as the member: his own number on each.
    rows.ianOut = await logCall(ian, tenantId, {
      direction: 'outbound',
      from: '+918000000002',
      to: '+917000000001',
      notes: 'Agreed a time',
    });
    rows.ianIn = await logCall(ian, tenantId, {
      direction: 'inbound',
      from: '+917000000002',
      to: '+918000000002',
      notes: 'Asked for a call back',
    });
  });

  afterAll(async () => {
    for (const c of Object.values(mcp)) await c.close().catch(() => undefined);
  });

  it("are in the person's copy, without sealed values or code hashes", async () => {
    expect(await withToken(mcp.hal.accessToken, '/api/cards')).toBe(200);
    const res = await file(hal, 'export');
    expect(res.status).toBe(200);
    const done = await finished(hal, res.body.value.id);
    expect(done.status).toBe('completed');
    const zip = await archive(hal, done.files[0]);
    expect(json(zip, 'features/calendarConnections.json')).toMatchObject([
      { id: rows.connection, provider: 'google', account: hal.email },
    ]);
    expect(json(zip, 'features/calendarEvents.json')).toMatchObject([
      { record: { entity: 'card', id: cardId }, externalId: 'google-event-1' },
    ]);
    expect(json(zip, 'features/calendarFeeds.json')).toMatchObject([{ label: 'Hal phone' }]);
    expect(json(zip, 'features/calendarInvites.json')).toMatchObject([
      { tenantId, email: hal.email.toUpperCase(), record: { entity: 'card', id: cardId } },
    ]);
    expect(
      json(zip, 'features/calls.json')
        .map((c: Json) => c.id)
        .sort(),
    ).toEqual([rows.callIn, rows.callOut].sort());
    expect(json(zip, 'features/acceptances.json')).toMatchObject([
      {
        name: 'fixture.terms',
        signerName: 'Hal Privacy',
        otpAddress: hal.email,
        ip: '203.0.113.5',
      },
    ]);
    expect(json(zip, 'features/otpChallenges.json')).toHaveLength(2);
    expect(json(zip, 'mcp-connections.json')).toMatchObject([
      { clientId: mcp.hal.clientId, scopes: expect.arrayContaining(['ledgers:read']) },
    ]);
    // What the person is, never the keys to their accounts.
    const everything = [...zip.values()].map((b) => b.toString('utf8')).join('\n');
    expect(everything).not.toContain('not-a-sealed-value');
    expect(everything).not.toContain('hash-never-exported');
    expect(everything).not.toContain('Another business');
  });

  it('are erased or kept as decided, counted per part, and nothing of another business moves', async () => {
    const before = erasedAfterCommit.length;
    const res = await file(hal, 'erase');
    expect(res.status).toBe(200);
    const done = await finished(ana, res.body.value.id);
    expect(done.status).toBe('completed');
    expect(done.outcome).toMatchObject({
      features: { calendar: 4, calls: 2, integrations: 2 },
      kept: { 'acceptance.evidence': { kept: 1, keepReason: 'acceptance_evidence' } },
      redacted: { inbound: 1 },
      account: true,
    });
    // The card's delivery (and the bus's own, if it fanned the card out to the endpoint).
    expect(done.outcome.redacted.deliveries).toBeGreaterThanOrEqual(1);
    expect(done.outcome.redacted.attempts).toBeGreaterThanOrEqual(1);
    expect(done.outcome.features.acceptance).toBeGreaterThanOrEqual(2);
    expect(done.outcome.framework.oauth).toBeGreaterThanOrEqual(2);

    // Calendars: the connection, its links, its inbound connection and events, the feed, the
    // sign-in and the invite are gone.
    const count = async (sql: string, params: unknown[]) =>
      Number((await one(`select count(*)::int as n from ${sql}`, params)).n);
    expect(await count('app.calendar_connections where user_id = $1', [hal.id])).toBe(0);
    expect(
      await count('app.calendar_event_links where connection_id = $1', [rows.connection]),
    ).toBe(0);
    expect(await count('app.integration_connections where id = $1', [rows.calendarInbound])).toBe(
      0,
    );
    expect(
      await count('app.integration_inbound where connection_id = $1', [rows.calendarInbound]),
    ).toBe(0);
    expect(await count('app.calendar_feeds where user_id = $1', [hal.id])).toBe(0);
    expect(await count('app.calendar_oauth_states where user_id = $1', [hal.id])).toBe(0);
    expect(
      (
        await pool.query('select tenant_id from app.calendar_invites where resource_id = $1', [
          cardId,
        ])
      ).rows,
    ).toEqual([{ tenant_id: raviTenant }]);

    // Calls: his number, the notes and the error are off; the other side and the call stay.
    const callOf = (callId: string) =>
      one('select from_number, to_number, notes from app.call_logs where id = $1', [callId]);
    expect(await callOf(rows.callIn)).toEqual({
      from_number: null,
      to_number: OTHER_LINE,
      notes: null,
    });
    expect(await callOf(rows.callOut)).toEqual({
      from_number: OTHER_LINE,
      to_number: null,
      notes: null,
    });
    expect(await callOf(rows.callElsewhere)).toEqual({
      from_number: `+${HAL_NUMBER}`,
      to_number: null,
      notes: 'Another business',
    });
    // Its audit copies lose them too.
    const logged = await one(
      `select after from audit.events where resource_type = 'call' and resource_id = $1
         and action = 'call.create'`,
      [rows.callIn],
    );
    expect(logged.after).not.toHaveProperty('from');
    expect(logged.after).not.toHaveProperty('notes');
    expect(logged.after).toHaveProperty('to', OTHER_LINE);

    // The bus: the card's body without its personal fields, the answer gone, the payload that
    // wrote it emptied; his number and email nulled where they were whole values.
    const bodyOf = async (d: string) =>
      JSON.parse(
        (await one('select body from app.integration_deliveries where id = $1', [d])).body,
      );
    const card = await bodyOf(rows.cardDelivery);
    expect(card.data.row).toEqual({ id: cardId, amountMinor: 300 });
    for (const d of (
      await pool.query('select body from app.integration_deliveries where resource_id = $1', [
        cardId,
      ])
    ).rows) {
      expect(JSON.parse(d.body).data.row).not.toHaveProperty('name');
      expect(JSON.parse(d.body).data.row).not.toHaveProperty('phone');
    }
    expect(
      (
        await one('select response from app.integration_attempts where delivery_id = $1', [
          rows.cardDelivery,
        ])
      ).response,
    ).toBeNull();
    expect((await bodyOf(rows.namingDelivery)).data.row).toEqual({
      id: 'r1',
      title: 'Ring back',
      phone: null,
      note: `Ring +${HAL_NUMBER} later`,
    });
    const dataOf = async (i: string) =>
      (await one('select data from app.integration_inbound where id = $1', [i])).data;
    expect(await dataOf(rows.wroteCard)).toBeNull();
    expect(await dataOf(rows.mailInbound)).toEqual({
      attendee: { email: null, name: 'Hal' },
      text: null,
    });
    expect((await bodyOf(rows.otherDelivery)).data.row.phone).toBe(`+${HAL_NUMBER}`);
    expect((await dataOf(rows.otherInbound)).attendee.email).toBe(hal.email.toUpperCase());

    // Acceptance: his codes go, the evidence stays as it was.
    expect(
      await count('channel.otp_challenges where tenant_id = $1 and lower(address) = $2', [
        tenantId,
        hal.email,
      ]),
    ).toBe(0);
    expect(
      await count('channel.otp_challenges where tenant_id = $1 and address = $2', [
        raviTenant,
        hal.email,
      ]),
    ).toBe(1);
    expect(
      await one('select signer_name, ip from audit.acceptances where signer_user_id = $1', [
        hal.id,
      ]),
    ).toEqual({ signer_name: 'Hal Privacy', ip: '203.0.113.5' });

    // MCP: his grants are gone, and his token is refused.
    for (const t of ['oauth_consent', 'oauth_access_token', 'oauth_refresh_token'])
      expect(await count(`public.${t} where user_id = $1`, [hal.id])).toBe(0);
    expect(await withToken(mcp.hal.accessToken, '/api/cards')).toBe(401);

    // Work outside the database ran once the erasure had committed; its failure changed nothing.
    const after = await eventually(() =>
      erasedAfterCommit
        .slice(before)
        .find((e) => e.subject.kind === 'user' && e.subject.userId === hal.id),
    );
    expect(after.status).toBe('completed');
  });

  it('unlinks a team member from their calls and ends their grants in this business only', async () => {
    expect(await withToken(mcp.ianHere.accessToken, '/api/cards')).toBe(200);
    const res = await file(carol, 'erase', { for: { userId: ian.id }, intake: 'email' });
    expect(res.status).toBe(200);
    const done = await finished(carol, res.body.value.id);
    expect(done.status).toBe('completed');
    expect(done.outcome).toMatchObject({ features: { calls: 2 }, account: false });
    expect(done.outcome.framework.oauth).toBeGreaterThanOrEqual(2);
    const callOf = (callId: string) =>
      one(
        'select user_id, logged_by, from_number, to_number, notes from app.call_logs where id = $1',
        [callId],
      );
    // The number he called from, and the one he was called on, go; the other side and the
    // business's notes stay.
    expect(await callOf(rows.ianOut)).toEqual({
      user_id: null,
      logged_by: null,
      from_number: null,
      to_number: '+917000000001',
      notes: 'Agreed a time',
    });
    expect(await callOf(rows.ianIn)).toEqual({
      user_id: null,
      logged_by: null,
      from_number: '+917000000002',
      to_number: null,
      notes: 'Asked for a call back',
    });
    // His client here stops; the one in his own business still works.
    expect(await withToken(mcp.ianHere.accessToken, '/api/cards')).toBe(401);
    expect(await withToken(mcp.ianOwn.accessToken, '/api/cards')).toBe(200);
    expect(
      (
        await pool.query('select reference_id from public.oauth_consent where user_id = $1', [
          ian.id,
        ])
      ).rows,
    ).toEqual([{ reference_id: ianTenant }]);
  });

  it("are on the register, with the application's words for what stays", async () => {
    const reg = (await call(bob, 'GET', '/api/privacy/register')).body;
    expect(reg.parts.map((x: Json) => x.name)).toEqual(
      expect.arrayContaining([
        'calendar.connections',
        'calendar.invites',
        'calls.log',
        'integrations.payloads',
        'acceptance.codes',
        'mcp.grants',
      ]),
    );
    expect(reg.parts.find((x: Json) => x.name === 'acceptance.evidence')).toMatchObject({
      erase: 'keep',
      keepReason: 'acceptance_evidence',
      keepBasis: 'Kept as proof of what was agreed',
    });
    expect(reg.records.find((x: Json) => x.entity === 'ledgerEntry')).toMatchObject({
      keepReason: 'legal_hold',
      keepBasis: 'Kept while a legal hold lasts',
    });
  });

  it('redact a delivered record when a retention rule deletes it', async () => {
    await setTenantSettings(tenantId, { privacy: null });
    const old = (await call(eve, 'POST', '/api/cards', { name: 'Eve, long ago', phone: '+91 3' }))
      .body.value;
    await pool.query(
      `update app.fixture_ledgers_cards set created_at = now() - interval '40 days' where id = $1`,
      [old.id],
    );
    const endpoint = await id(
      `insert into app.integration_endpoints (tenant_id, url, events, secret_sealed)
       values ($1, 'https://receiver.test/old', '{*}', 'sealed') returning id`,
      [tenantId],
    );
    const delivery = await id(
      `insert into app.integration_deliveries (tenant_id, endpoint_id, event_id, event_name,
         resource_type, resource_id, body, status)
       values ($1, $2, gen_random_uuid()::text, 'card.created', 'card', $3, $4, 'delivered')
       returning id`,
      [tenantId, endpoint, old.id, webhookBody('card', old.id, { ...old })],
    );
    expect((await privacy().runRetention({ tenantId }))['ledgers.cards']).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(
      (await one('select body from app.integration_deliveries where id = $1', [delivery])).body,
    );
    expect(body.data.row).not.toHaveProperty('name');
    expect(body.data.row).not.toHaveProperty('phone');
    expect(body.data.row).toHaveProperty('id', old.id);
  });
});
