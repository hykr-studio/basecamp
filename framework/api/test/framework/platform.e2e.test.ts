// The platform tier (B19): named operators above the businesses, support access a business
// consents to (time-boxed, read-only unless allowed, every request logged, every write audited on
// behalf of the operator), making a business for a person, platform-managed flags, platform scope
// for shared records, the routing hook for inbound requests, and the usage report across
// businesses. Support access holds only capabilities declared supportable, and a share link made
// under it ends with it (S1). The fixture's src/features/platform adds issues (shareable), parts
// and the router.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type CapabilityDef, capabilities } from '@hykr/contracts';
import { configureSharedRecords } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformRoutingService } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  type Json,
  makeOperator,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { codes, platformServer } from '../fixture/dist/features/platform/index.js';

const root = new Person('Root Platform'); // an operator holding everything
const helper = new Person('Helper Platform'); // an operator who asks for support access
const usher = new Person('Usher Platform'); // an operator holding only the usage report
const nobody = new Person('Nobody Platform'); // signed up, no operator
const ana = new Person('Ana Platform'); // owns business A
const sam = new Person('Sam Platform'); // staff in A
const bo = new Person('Bo Platform'); // owns business B
const curator = new Person('Curator Platform'); // owns the platform's own business
const newcomer = new Person('Newcomer Platform'); // gets a business from an operator
let A = '';
let B = '';
let platform = '';
let rootId = '';
let helperId = '';

/** A stand-in for the WhatsApp Cloud API: records what the adapter sends. */
const sent: { to: string; type?: string }[] = [];
let stub: Server;
const secret = 'test-app-secret';
const NUMBER = `pn-platform-${Date.now()}`;
let seq = 0;
const phone = () => `9188${String(Date.now()).slice(-6)}${seq++ % 10}`;

const inA = { 'x-tenant-id': '' };
const as = (p: Person, tenant: string) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenant });

const audits = async (tenant: string | null, action: string) =>
  (
    await pool.query(
      `select action, outcome, rule, actor_kind, actor_id, on_behalf_of, resource_id, after
       from audit.events where ${tenant ? 'tenant_id = $2' : 'tenant_id is null'} and action = $1
       order by at`,
      tenant ? [action, tenant] : [action],
    )
  ).rows;

const issueIn = async (person: Person, tenant: string, title: string, note?: string) =>
  (await as(person, tenant)('POST', '/api/issues', { title, ...(note ? { note } : {}) })).body
    .value as { id: string };

async function inbound(from: string, text: string, id = `m-platform-${Date.now()}-${seq++}`) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: NUMBER },
              contacts: [{ wa_id: from, profile: { name: 'Sender Platform' } }],
              messages: [
                {
                  from,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = await fetch(`${server.base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  expect(res.status).toBe(200);
  return id;
}

const routedRow = async (ref: string) =>
  (await pool.query('select * from app.platform_routed where ref = $1', [ref])).rows[0] as
    | Record<string, unknown>
    | undefined;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      sent.push(JSON.parse(data));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messages: [{ id: `wamid.pl.${Date.now()}.${sent.length}` }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = secret;
  process.env.WA_VERIFY_TOKEN = 'test-verify';
  await boot(platformServer);
  for (const p of [root, helper, usher, nobody, ana, sam, bo, curator, newcomer]) await p.signUp();
  A = (await me(ana)).tenantId;
  B = (await me(bo)).tenantId;
  platform = (await me(curator)).tenantId;
  inA['x-tenant-id'] = A;
  await addMember(sam, A, ['staff']);
  rootId = await makeOperator(root);
  helperId = await makeOperator(helper, ['platform.support']);
  await makeOperator(usher, ['platform.usage']);
  configureSharedRecords({ platformTenantId: platform });
});
afterAll(async () => {
  configureSharedRecords({ platformTenantId: undefined });
  stub?.close();
  await shutdown();
});

describe('operators', () => {
  it('anyone signed in may ask whether they are one; only operators are', async () => {
    expect((await fetch(`${server.base}/api/platform/me`)).status).toBe(401);
    expect((await nobody.call('GET', '/api/platform/me')).body).toEqual({ operator: null });
    const mine = (await root.call('GET', '/api/platform/me')).body;
    expect(mine.operator).toMatchObject({ id: rootId });
    expect(mine.operator.capabilities).toEqual(
      expect.arrayContaining(['platform.operators', 'platform.tenants', 'platform.support']),
    );
    // The command line's way in (saveOperator) is audited as the system.
    expect(await audits(null, 'platform.operators.add')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_kind: 'system',
          actor_id: 'cli.operators',
          resource_id: rootId,
        }),
      ]),
    );
  });

  it('their routes need a signed-in operator holding the capability, never software', async () => {
    expect((await fetch(`${server.base}/api/platform/tenants`)).status).toBe(401);
    expect((await nobody.call('GET', '/api/platform/tenants')).body).toMatchObject({
      rule: 'not_an_operator',
    });
    expect((await helper.call('GET', '/api/platform/tenants')).body).toMatchObject({
      rule: 'operator_capability',
    });
    // The assistant acting for an operator, and a page's WebMCP tools, are refused.
    const agent = await asAssistant(`user:${root.id}`, { 'x-channel': 'app' })(
      'GET',
      '/api/platform/tenants',
    );
    expect(agent.status).toBe(403);
    expect(
      (await root.call('GET', '/api/platform/tenants', undefined, { 'x-channel': 'webmcp' }))
        .status,
    ).toBe(403);
    expect((await root.call('GET', '/api/platform/tenants')).status).toBe(200);
  });

  it('are added, changed and disabled by an operator, audited; never oneself', async () => {
    const added = await root.call('POST', '/api/platform/operators', {
      email: nobody.email,
      capabilities: ['platform.usage'],
      note: 'reports',
    });
    expect(added.status).toBe(201);
    expect(added.body.value).toMatchObject({
      email: nobody.email,
      capabilities: ['platform.usage'],
    });
    const id = added.body.value.id;
    expect((await nobody.call('GET', '/api/platform/me')).body.operator).toMatchObject({ id });
    const [row] = await audits(null, 'platform.operators.add').then((r) =>
      r.filter((a) => a.resource_id === null && a.on_behalf_of === `operator:${rootId}`),
    );
    expect(row).toMatchObject({ actor_kind: 'user', actor_id: root.id });
    expect(
      (
        await root.call('POST', '/api/platform/operators', {
          email: nobody.email,
          capabilities: ['platform.usage'],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await root.call('POST', '/api/platform/operators', {
          email: 'nobody-at-all@test.local',
          capabilities: ['platform.usage'],
        })
      ).body,
    ).toMatchObject({ error: 'no_account' });
    expect(
      (
        await root.call('POST', '/api/platform/operators', {
          email: sam.email,
          capabilities: ['platform.everything'],
        })
      ).body,
    ).toMatchObject({ error: 'unknown_capability' });
    // Disabled: at once.
    const off = await root.call('PATCH', `/api/platform/operators/${id}`, { enabled: false });
    expect(off.body.value.disabledAt).toEqual(expect.any(String));
    expect((await nobody.call('GET', '/api/platform/me')).body).toEqual({ operator: null });
    expect((await nobody.call('GET', '/api/platform/usage')).body.rule).toBe('not_an_operator');
    expect(
      (await root.call('PATCH', `/api/platform/operators/${rootId}`, { enabled: false })).body,
    ).toMatchObject({ rule: 'own_operator' });
    const list = (await root.call('GET', '/api/platform/operators')).body;
    expect(list.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining([rootId, id]));
  });
});

describe('businesses', () => {
  let made = '';

  it('an operator makes one for a person with an account: they own it', async () => {
    const res = await root.call('POST', '/api/platform/tenants', {
      name: 'Provisioned Platform',
      owner: { email: newcomer.email.toUpperCase() },
    });
    expect(res.status).toBe(201);
    expect(res.body.value).toMatchObject({ name: 'Provisioned Platform', members: 1 });
    made = res.body.value.id;
    expect(res.body.value.defaultOwnerId).toBe(newcomer.id);
    // Their own business stays their default; they work in the new one by naming it.
    const there = (await newcomer.call('GET', '/api/me', undefined, { 'x-tenant-id': made })).body;
    expect(there).toMatchObject({ tenantId: made, roles: ['owner'], as: 'member' });
    expect((await me(newcomer)).tenantId).not.toBe(made);
    // Audited in the new business, on behalf of the operator, and announced.
    const [row] = await audits(made, 'tenant.provision');
    expect(row).toMatchObject({
      actor_kind: 'system',
      actor_id: 'platform.tenants',
      on_behalf_of: `operator:${rootId}`,
      outcome: 'committed',
    });
    const { rows } = await pool.query(
      "select row from app.domain_events where tenant_id = $1 and name = 'tenant.provisioned'",
      [made],
    );
    expect(rows[0].row).toMatchObject({ id: made, ownerId: newcomer.id, operatorId: rootId });
  });

  it('nobody with that email: 404, nothing made', async () => {
    const res = await root.call('POST', '/api/platform/tenants', {
      name: 'Ghost Platform',
      owner: { email: 'ghost-platform@test.local' },
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'no_account' });
    const { rows } = await pool.query("select id from app.tenants where name = 'Ghost Platform'");
    expect(rows).toEqual([]);
  });

  it('a retry with the same idempotency key makes one business and answers the same', async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const named = async (name: string) =>
      (await pool.query('select id from app.tenants where name = $1', [`${name} ${tag}`])).rows;
    const madeOnce = async (name: string) => {
      const rows = await named(name);
      expect(rows).toHaveLength(1);
      const id = rows[0].id as string;
      expect(
        (await audits(id, 'tenant.provision')).filter((a) => a.outcome === 'committed'),
      ).toHaveLength(1);
      const events = await pool.query(
        "select id from app.domain_events where tenant_id = $1 and name = 'tenant.provisioned'",
        [id],
      );
      expect(events.rows).toHaveLength(1);
      return id;
    };
    const provision = (name: string, key?: string) =>
      root.call(
        'POST',
        '/api/platform/tenants',
        { name: `${name} ${tag}`, owner: { email: newcomer.email } },
        key ? { 'idempotency-key': key } : {},
      );
    // The answer was lost; the client asks again with the same key.
    const key = `provision-${crypto.randomUUID()}`;
    const first = await provision('Retried Platform', key);
    expect(first.status).toBe(201);
    const again = await provision('Retried Platform', key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await madeOnce('Retried Platform')).toBe(first.body.value.id);
    // The same key for another request: refused, nothing made.
    expect((await provision('Other Platform', key)).status).toBe(409);
    expect(await named('Other Platform')).toEqual([]);
    // Both at once: one business, one answer.
    const raced = `provision-${crypto.randomUUID()}`;
    const [a, b] = await Promise.all([
      provision('Raced Platform', raced),
      provision('Raced Platform', raced),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(await madeOnce('Raced Platform')).toBe(a.body.value.id);
    // Without a key, each request is its own.
    await provision('Unkeyed Platform');
    await provision('Unkeyed Platform');
    expect(await named('Unkeyed Platform')).toHaveLength(2);
  });

  it('are listed, read and renamed; a platform-managed flag is switched', async () => {
    const page = (await root.call('GET', '/api/platform/tenants?q=provisioned%20plat')).body;
    expect(page.items.map((t: { id: string }) => t.id)).toEqual([made]);
    expect((await root.call('GET', `/api/platform/tenants/${made}`)).body).toMatchObject({
      name: 'Provisioned Platform',
    });
    const renamed = await root.call('PATCH', `/api/platform/tenants/${made}`, {
      name: 'Renamed Platform',
    });
    expect(renamed.body.value).toMatchObject({ name: 'Renamed Platform' });
    expect((await root.call('GET', `/api/platform/tenants/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    // The business cannot switch a platform-managed flag; the operator can.
    expect(
      (
        await newcomer.call(
          'PUT',
          '/api/features/issues.priority',
          { on: true },
          { 'x-tenant-id': made },
        )
      ).body,
    ).toMatchObject({ rule: 'platform_managed' });
    const on = await root.call('PUT', `/api/platform/tenants/${made}/features/issues.priority`, {
      on: true,
    });
    expect(on.body).toMatchObject({
      status: 'done',
      value: { key: 'issues.priority', on: true },
    });
    expect(
      (await newcomer.call('GET', '/api/me', undefined, { 'x-tenant-id': made })).body.features,
    ).toEqual(['issues.priority']);
    const [flag] = (await audits(made, 'settings.feature')).filter(
      (a) => a.outcome === 'committed',
    );
    expect(flag).toMatchObject({ actor_id: 'platform.flags', on_behalf_of: `operator:${rootId}` });
    expect(
      (await root.call('PUT', `/api/platform/tenants/${made}/features/no.such`, { on: true }))
        .status,
    ).toBe(404);
  });
});

describe('support access', () => {
  let ticket = '';
  let samTicket = '';
  let grant = '';
  const ask = (body: Record<string, unknown>, who = helper) =>
    who.call('POST', '/api/platform/support', {
      tenantId: A,
      reason: 'Look at a failing import',
      roles: ['admin'],
      capabilities: ['backoffice.use'],
      minutes: 60,
      ...body,
    });

  beforeAll(async () => {
    ticket = (await issueIn(ana, A, 'Leaking tap', 'private')).id;
    samTicket = (await issueIn(sam, A, 'Sam’s own')).id;
  });

  it('a request names roles the business has and capabilities support may hold', async () => {
    expect((await ask({ roles: ['wizard'] })).body).toMatchObject({ error: 'unknown_role' });
    expect((await ask({ capabilities: ['members.manage'] })).body).toMatchObject({
      error: 'capability_withheld',
    });
    expect((await ask({ capabilities: ['shared.publish'] })).body).toMatchObject({
      error: 'capability_withheld',
    });
    expect((await ask({ tenantId: crypto.randomUUID() })).status).toBe(404);
    // Longer than the business allows: refused, and the refusal is audited there.
    const long = await ask({ minutes: 600 });
    expect(long.status).toBe(403);
    expect(long.body).toMatchObject({ rule: 'support_too_long' });
    expect((await audits(A, 'support.request')).map((a) => a.outcome)).toContain('denied');
  });

  it('a business that takes no requests refuses them', async () => {
    const closed = await as(bo, B)('PUT', '/api/support-access/settings', {
      requests: false,
      maxMinutes: 120,
      requestHours: 24,
    });
    expect(closed.body).toMatchObject({ status: 'done' });
    expect((await as(bo, B)('GET', '/api/support-access/settings')).body).toMatchObject({
      requests: false,
      maxMinutes: 120,
    });
    expect((await ask({ tenantId: B })).body).toMatchObject({ rule: 'support_closed' });
  });

  it('waits for the business: before consent the operator reaches nothing', async () => {
    const res = await ask({});
    expect(res.status).toBe(201);
    expect(res.body.value).toMatchObject({ status: 'requested', roles: ['admin'] });
    grant = res.body.value.id;
    expect((await as(helper, A)('GET', '/api/issues')).body).toMatchObject({
      rule: 'not_a_member',
    });
    const [row] = await audits(A, 'support.request').then((r) =>
      r.filter((a) => a.outcome === 'committed'),
    );
    expect(row).toMatchObject({ actor_kind: 'system', on_behalf_of: `operator:${helperId}` });
    const { rows } = await pool.query(
      "select name from app.domain_events where tenant_id = $1 and name = 'support.requested'",
      [A],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("only the business's people who consent see it; another business never does", async () => {
    expect((await as(sam, A)('GET', '/api/support-access')).body).toMatchObject({
      rule: 'support_consent',
    });
    expect((await as(bo, B)('GET', `/api/support-access/${grant}`)).status).toBe(404);
    expect((await as(bo, B)('POST', `/api/support-access/${grant}/consent`, {})).status).toBe(404);
    const list = (await as(ana, A)('GET', '/api/support-access')).body;
    expect(list.find((g: { id: string }) => g.id === grant)).toMatchObject({
      status: 'requested',
      operator: { id: helperId, email: helper.email },
    });
    expect(
      (await as(ana, A)('POST', `/api/support-access/${grant}/consent`, { minutes: 90 })).body,
    ).toMatchObject({ error: 'longer_than_asked' });
    expect(
      (await as(ana, A)('POST', `/api/support-access/${grant}/consent`, { access: 'write' })).body,
    ).toMatchObject({ error: 'more_than_asked' });
  });

  it('consented: the operator reads with the roles, only the capabilities named, read only', async () => {
    const res = await as(ana, A)('POST', `/api/support-access/${grant}/consent`, { minutes: 30 });
    expect(res.body.value).toMatchObject({ status: 'active', minutes: 30, consentedBy: ana.id });
    const mine = (await as(helper, A)('GET', '/api/me')).body;
    expect(mine).toMatchObject({
      tenantId: A,
      as: 'support',
      roles: ['admin'],
      capabilities: ['backoffice.use'],
    });
    const list = (await as(helper, A)('GET', '/api/issues')).body;
    expect(list.items.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining([ticket, samTicket]),
    );
    // The note needs a capability the business did not consent to.
    for (const item of list.items) expect(item).not.toHaveProperty('note');
    expect((await as(ana, A)('GET', `/api/issues/${ticket}`)).body.note).toBe('private');
    // Read only: no write reaches a handler.
    const write = await as(helper, A)('PATCH', `/api/issues/${ticket}`, { title: 'Changed' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ rule: 'support_read_only' });
    expect((await as(ana, A)('GET', `/api/issues/${ticket}`)).body.title).toBe('Leaking tap');
    // The assistant acting for the operator stands where the operator does, and reads only too.
    const agent = asAssistant(`user:${helper.id}`, { 'x-channel': 'app', 'x-tenant-id': A });
    expect((await agent('GET', `/api/issues/${ticket}`)).status).toBe(200);
    expect((await agent('DELETE', `/api/issues/${ticket}`)).status).toBe(403);
    // Another business: nothing.
    expect((await as(helper, B)('GET', '/api/issues')).body.rule).toBe('not_a_member');
    // Never on WhatsApp's assurance.
    expect(
      (
        await helper.call('GET', '/api/issues', undefined, {
          'x-tenant-id': A,
          'x-channel': 'whatsapp',
        })
      ).status,
    ).toBe(400);
  });

  it('every request made under it is logged for the business and the operator', async () => {
    const logged = await eventually(async () => {
      const rows: { method: string; actorKind: string }[] = (
        await as(ana, A)('GET', `/api/support-access/${grant}/activity`)
      ).body;
      const has = (method: string, actorKind: string) =>
        rows.some((r) => r.method === method && r.actorKind === actorKind);
      return has('DELETE', 'agent') && has('PATCH', 'user') ? rows : undefined;
    });
    expect(logged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'GET',
          path: '/api/issues',
          status: 200,
          actorKind: 'user',
        }),
        expect.objectContaining({ method: 'GET', path: '/api/me', status: 200 }),
        // Refused by a guard before any handler: logged with the refusal, the business sees
        // that support tried to write.
        expect.objectContaining({
          method: 'PATCH',
          path: `/api/issues/${ticket}`,
          status: 403,
          actorKind: 'user',
        }),
        expect.objectContaining({
          method: 'DELETE',
          path: `/api/issues/${ticket}`,
          status: 403,
          actorKind: 'agent',
        }),
      ]),
    );
    const theirs = (await helper.call('GET', `/api/platform/support/${grant}/activity`)).body;
    expect(theirs.length).toBe(logged.length);
    expect((await usher.call('GET', `/api/platform/support/${grant}`)).status).toBe(403);
  });

  it('revoked: it ends at once', async () => {
    expect(
      (await as(ana, A)('POST', `/api/support-access/${grant}/revoke`)).body.value,
    ).toMatchObject({ status: 'revoked', endedBy: ana.id });
    expect((await as(helper, A)('GET', '/api/issues')).body.rule).toBe('not_a_member');
    expect((await as(ana, A)('POST', `/api/support-access/${grant}/revoke`)).status).toBe(409);
    expect((await audits(A, 'support.revoke'))[0]).toMatchObject({
      actor_kind: 'user',
      actor_id: ana.id,
    });
  });

  it('a write grant writes, audited as the operator on behalf of support; it never decides', async () => {
    const asked = await ask({ access: 'write', capabilities: ['fixture.issue.note'] });
    const id = asked.body.value.id;
    await as(ana, A)('POST', `/api/support-access/${id}/consent`, {});
    const changed = await as(helper, A)('PATCH', `/api/issues/${ticket}`, {
      title: 'Fixed tap',
    });
    expect(changed.body.value).toMatchObject({ title: 'Fixed tap', note: 'private' });
    const [row] = (await audits(A, 'issue.update')).filter((a) => a.resource_id === ticket);
    expect(row).toMatchObject({
      actor_kind: 'user',
      actor_id: helper.id,
      on_behalf_of: `support:${id}`,
    });
    // The application's rule: support's deletes wait for the business, which decides.
    const parked = await as(helper, A)('DELETE', `/api/issues/${samTicket}`);
    expect(parked.body.status).toBe('needs_approval');
    const approval = parked.body.approval.id;
    expect(
      (await audits(A, 'issue.delete')).find((a) => a.outcome === 'needs_approval'),
    ).toMatchObject({ on_behalf_of: `support:${id}` });
    expect((await as(helper, A)('POST', `/api/approvals/${approval}/approve`)).body).toMatchObject({
      rule: 'support_cannot_decide',
    });
    // The operator ends it; the approved replay then has nobody to act for.
    expect((await helper.call('DELETE', `/api/platform/support/${id}`)).body.value).toMatchObject({
      status: 'ended',
      endedBy: `operator:${helperId}`,
    });
    const decided = await as(ana, A)('POST', `/api/approvals/${approval}/approve`);
    expect(decided.body.status).toBe('failed');
    expect((await as(ana, A)('GET', `/api/issues/${samTicket}`)).status).toBe(200);
  });

  it('ends when its time is up, and an unanswered request expires', async () => {
    const asked = await ask({});
    const id = asked.body.value.id;
    await as(ana, A)('POST', `/api/support-access/${id}/consent`, {});
    expect((await as(helper, A)('GET', '/api/issues')).status).toBe(200);
    await pool.query(
      "update app.platform_support_grants set ends_at = now() - interval '1 second' where id = $1",
      [id],
    );
    expect((await as(helper, A)('GET', '/api/issues')).body.rule).toBe('not_a_member');
    expect((await helper.call('GET', `/api/platform/support/${id}`)).body.status).toBe('ended');

    const late = (await ask({})).body.value.id;
    await pool.query(
      "update app.platform_support_grants set request_expires_at = now() - interval '1 second' where id = $1",
      [late],
    );
    expect(
      (await as(ana, A)('POST', `/api/support-access/${late}/consent`, {})).body,
    ).toMatchObject({ error: 'not_requested' });
    expect((await as(ana, A)('GET', `/api/support-access/${late}`)).body.status).toBe('expired');
  });

  it('a declined request gives nothing; a disabled operator loses an active grant', async () => {
    const no = (await ask({})).body.value.id;
    expect(
      (await as(ana, A)('POST', `/api/support-access/${no}/decline`)).body.value,
    ).toMatchObject({
      status: 'declined',
    });
    expect((await as(ana, A)('POST', `/api/support-access/${no}/consent`, {})).status).toBe(409);

    const yes = (await ask({})).body.value.id;
    await as(ana, A)('POST', `/api/support-access/${yes}/consent`, {});
    expect((await as(helper, A)('GET', '/api/issues')).status).toBe(200);
    await root.call('PATCH', `/api/platform/operators/${helperId}`, { enabled: false });
    expect((await as(helper, A)('GET', '/api/issues')).body.rule).toBe('not_a_member');
    await root.call('PATCH', `/api/platform/operators/${helperId}`, { enabled: true });
    expect((await as(helper, A)('GET', '/api/issues')).status).toBe(200);
    await helper.call('DELETE', `/api/platform/support/${yes}`);
  });
});

// docs/decisions/S1.md: support access holds only what is declared supportable, and what it makes
// ends with it.
describe('support access leaves nothing behind its time box', () => {
  let ticket = '';
  const request = (body: Record<string, unknown>) =>
    helper.call('POST', '/api/platform/support', {
      tenantId: A,
      reason: 'Check a shared issue',
      roles: ['admin'],
      capabilities: [],
      access: 'write',
      minutes: 60,
      ...body,
    });
  /** A write grant the business consented to. */
  const consented = async () => {
    const asked = await request({});
    expect(asked.status).toBe(201);
    const id = asked.body.value.id as string;
    const res = await as(ana, A)('POST', `/api/support-access/${id}/consent`, {});
    expect(res.body.value).toMatchObject({ status: 'active' });
    return id;
  };
  /** As a grant stored before these capabilities were withheld would hold them. */
  const storedWith = (id: string, caps: string[]) =>
    pool.query('update app.platform_support_grants set capabilities = $2 where id = $1', [
      id,
      caps,
    ]);
  /** A link opened by someone with no session at all. */
  const opened = async (token: string) => {
    const res = await fetch(`${server.base}/api/share/${token}`);
    return { status: res.status, body: await res.json() };
  };
  const shareTicket = (p: Person) =>
    as(p, A)('POST', '/api/shares', { target: { entity: 'issue', id: ticket }, expiresInDays: 90 });
  /**
   * The link support would make if a capability that makes links were ever declared supportable:
   * the guard below must hold even then.
   */
  async function linkUnderSupport(): Promise<Json> {
    const def = capabilities.get('shares.create') as CapabilityDef;
    def.supportable = true;
    try {
      const made = await shareTicket(helper);
      expect(made.status).toBe(201);
      return made.body.value;
    } finally {
      def.supportable = false;
    }
  }

  beforeAll(async () => {
    ticket = (await issueIn(ana, A, 'Shared tap', 'private')).id;
  });

  it('every capability of the framework says whether support may hold it', () => {
    // A new one that says nothing is never held (the default), but its author must decide.
    const unsaid = capabilities
      .all()
      .filter((c) => !c.name.startsWith('fixture.') && c.grantable !== false)
      .filter((c) => typeof c.supportable !== 'boolean')
      .map((c) => c.name);
    expect(unsaid).toEqual([]);
  });

  it('never holds a capability not declared supportable, even when asked', async () => {
    for (const capability of [
      'shares.create',
      'shares.manage',
      'privacy.manage',
      'agents.manage',
      'data.export',
      'approvals.decide',
      // The application's, declared without `supportable`.
      'fixture.issue.close',
    ]) {
      const res = await request({ capabilities: [capability] });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'capability_withheld' });
    }
    // The application's, declared supportable.
    const fine = await request({ capabilities: ['fixture.issue.note'] });
    expect(fine.status).toBe(201);
    await helper.call('DELETE', `/api/platform/support/${fine.body.value.id}`);
  });

  it('share links: never made; a link made under it ends when it is revoked', async () => {
    const id = await consented();
    await storedWith(id, ['shares.create', 'shares.manage']);
    expect((await as(helper, A)('GET', '/api/me')).body).toMatchObject({
      as: 'support',
      capabilities: [],
    });
    const refused = await shareTicket(helper);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'shares_create' });
    // The business's own link to the same record.
    const theirs = (await shareTicket(ana)).body.value;
    expect(theirs.onBehalfOf).toBeNull();

    const link = await linkUnderSupport();
    expect(link.onBehalfOf).toBe(`support:${id}`);
    const grant = (await helper.call('GET', `/api/platform/support/${id}`)).body;
    // Asked for 90 days, it lasts no longer than the access.
    expect(Date.parse(link.expiresAt)).toBeLessThanOrEqual(Date.parse(grant.endsAt));
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
    const open = await opened(link.token);
    expect(open.status).toBe(200);
    expect(open.body.record).toMatchObject({ entity: 'issue', id: ticket });

    // The owner revokes the access: its link goes with it, in the same write, audited.
    const revoked = await as(ana, A)('POST', `/api/support-access/${id}/revoke`);
    expect(revoked.body.value).toMatchObject({ status: 'revoked' });
    const gone = await opened(link.token);
    expect(gone.status).toBe(410);
    expect(gone.body).toMatchObject({ error: 'link_revoked' });
    const { rows } = await pool.query(
      'select revoked_by, on_behalf_of from app.share_links where id = $1',
      [link.id],
    );
    expect(rows[0]).toEqual({ revoked_by: 'support.ended', on_behalf_of: `support:${id}` });
    expect(
      (await audits(A, 'shareLink.update')).find((a) => a.resource_id === link.id),
    ).toMatchObject({ actor_kind: 'user', actor_id: ana.id, outcome: 'committed' });
    const listed = (await as(ana, A)('GET', `/api/shares?entity=issue&id=${ticket}`)).body.items;
    expect(listed.find((l: { id: string }) => l.id === link.id)).toMatchObject({
      status: 'revoked',
      onBehalfOf: `support:${id}`,
    });
    // The business's own link is the business's: it keeps working.
    expect((await opened(theirs.token)).status).toBe(200);
  });

  it('a link made under it reaches nothing while its operator is disabled, or once it is over', async () => {
    const id = await consented();
    await storedWith(id, ['shares.create']);
    const link = await linkUnderSupport();
    expect((await opened(link.token)).status).toBe(200);
    await root.call('PATCH', `/api/platform/operators/${helperId}`, { enabled: false });
    expect((await opened(link.token)).status).toBe(410);
    await root.call('PATCH', `/api/platform/operators/${helperId}`, { enabled: true });
    expect((await opened(link.token)).status).toBe(200);
    // Its time is up: nothing is written, the link still has days left, and it opens nothing.
    await pool.query(
      "update app.platform_support_grants set ends_at = now() - interval '1 second' where id = $1",
      [id],
    );
    expect((await helper.call('GET', `/api/platform/support/${id}`)).body.status).toBe('ended');
    const gone = await opened(link.token);
    expect(gone.status).toBe(410);
    expect(gone.body).toMatchObject({ error: 'link_revoked' });
  });

  it("personal data: another person's requests, archives and filings stay out of reach", async () => {
    // The owner's own copy of their data, with its archive.
    const filed = await as(ana, A)('POST', '/api/privacy/requests', { kind: 'export' });
    expect(filed.body.status).toBe('done');
    const requestId = filed.body.value.id as string;
    const done = await eventually(async () => {
      const r = (await as(ana, A)('GET', `/api/privacy/requests/${requestId}`)).body;
      return r?.status === 'completed' ? r : undefined;
    }, 20_000);
    const archive = done.files[0] as string;
    expect((await as(ana, A)('GET', `/api/files/${archive}`)).status).toBe(200);

    const id = await consented();
    await storedWith(id, ['privacy.manage']);
    const theOperator = as(helper, A);
    expect((await theOperator('GET', '/api/me')).body.capabilities).toEqual([]);
    expect((await theOperator('GET', `/api/privacy/requests/${requestId}`)).status).toBe(404);
    expect((await theOperator('GET', `/api/files/${archive}`)).status).toBe(404);
    const list = (await theOperator('GET', '/api/privacy/requests')).body.items;
    expect(list.map((r: { id: string }) => r.id)).not.toContain(requestId);
    for (const kind of ['export', 'erase']) {
      const res = await theOperator('POST', '/api/privacy/requests', {
        kind,
        for: { userId: ana.id },
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ rule: 'needs_privacy_manage' });
    }
    await helper.call('DELETE', `/api/platform/support/${id}`);
  });
});

describe('platform scope', () => {
  let part = '';

  it("an operator publishes the platform's shared rows without a membership, on its behalf", async () => {
    const res = await as(root, platform)('POST', '/api/parts', { title: 'Standard hinge' });
    expect(res.status).toBe(201);
    part = res.body.value.id;
    expect((await as(root, platform)('GET', '/api/me')).body).toMatchObject({
      as: 'operator',
      roles: [],
      capabilities: ['shared.publish'],
    });
    const [row] = await audits(platform, 'part.create');
    expect(row).toMatchObject({
      actor_kind: 'user',
      actor_id: root.id,
      on_behalf_of: `operator:${rootId}`,
    });
    const retitled = await as(root, platform)('POST', `/api/parts/${part}/retitle`, {
      title: 'Standard hinge v2',
    });
    expect(retitled.body.value).toMatchObject({ title: 'Standard hinge v2' });
  });

  it("the platform business's own people do not, by any path; other operators reach nothing", async () => {
    const made = await curator.call('POST', '/api/parts', { title: 'Curated' });
    expect(made.status).toBe(403);
    expect(made.body).toMatchObject({ rule: 'platform_scope_only' });
    const viaCommand = await curator.call('POST', `/api/parts/${part}/retitle`, { title: 'Mine' });
    expect(viaCommand.body).toMatchObject({ rule: 'platform_scope_only' });
    expect((await curator.call('GET', `/api/parts/${part}`)).body.title).toBe('Standard hinge v2');
    expect(
      (await audits(platform, 'part.retitle')).filter((a) => a.outcome === 'denied').length,
    ).toBe(1);
    expect((await as(helper, platform)('POST', '/api/parts', { title: 'x' })).body.rule).toBe(
      'not_a_member',
    );
  });

  it('every business reads them, read-only', async () => {
    const one = (await as(ana, A)('GET', `/api/parts/${part}`)).body;
    expect(one).toMatchObject({ title: 'Standard hinge v2', shared: true });
    expect((await as(ana, A)('PATCH', `/api/parts/${part}`, { title: 'No' })).body.rule).toBe(
      'shared_read_only',
    );
  });
});

describe('routing inbound requests', () => {
  beforeAll(async () => {
    expect(
      (await curator.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER }))
        .status,
    ).toBe(201);
    codes.set('acme', A);
    codes.set('boom', A);
    codes.set('self', platform);
  });

  it("a message to the platform's number becomes a record in the business a router chose", async () => {
    const from = phone();
    const ref = await inbound(from, 'Hello #acme, my tap leaks');
    const routed = await eventually(async () => {
      const r = await routedRow(ref);
      return r?.status === 'routed' ? r : undefined;
    }, 15_000);
    expect(routed).toMatchObject({
      router: 'fixture-by-code',
      tenant_id: A,
      resource_type: 'issue',
    });
    const { rows } = await pool.query(
      'select owner_id, customer_id, title from app.fixture_issues where id = $1',
      [routed.resource_id],
    );
    // The business's default owner's, for the sender as the business's own customer.
    const [contact] = (
      await pool.query(
        'select customer_id from channel.contacts where tenant_id = $1 and address = $2',
        [A, from],
      )
    ).rows;
    expect(rows[0]).toMatchObject({ owner_id: ana.id, customer_id: contact.customer_id });
    expect(rows[0].title).toContain('#acme');
    const [row] = (await audits(A, 'issue.create')).filter(
      (a) => a.resource_id === routed.resource_id,
    );
    expect(row).toMatchObject({ actor_kind: 'system', actor_id: 'platform.route' });
    // It is A's, and A's alone.
    expect((await as(bo, B)('GET', `/api/issues/${routed.resource_id}`)).status).toBe(404);
    expect((await as(ana, A)('GET', `/api/issues/${routed.resource_id}`)).status).toBe(200);

    // Routed once: asked again, the same answer, and still one issue.
    const routing = server.app?.get(PlatformRoutingService, {
      strict: false,
    }) as PlatformRoutingService;
    const again = await routing.route({ source: 'whatsapp', ref, text: 'Hello #acme, again' });
    expect(again).toMatchObject({ status: 'routed', resourceId: routed.resource_id, attempts: 1 });
  });

  it('nobody routes it: the platform keeps it, its assistant answers', async () => {
    const from = phone();
    const ref = await inbound(from, 'Just saying hello');
    await eventually(async () => (await routedRow(ref))?.status === 'unrouted');
    // The welcome, then the platform's assistant's answer.
    await eventually(
      () => sent.filter((s) => s.to === from && s.type === 'text').length >= 2,
      15_000,
    );
  });

  it('a delivery that fails rolls back; a router may not choose the platform itself', async () => {
    const routing = server.app?.get(PlatformRoutingService, {
      strict: false,
    }) as PlatformRoutingService;
    const before = (await pool.query('select count(*)::int as n from app.fixture_issues')).rows[0]
      .n;
    const failed = await routing.route({
      source: 'form',
      ref: `boom-${Date.now()}`,
      text: 'Please #boom',
    });
    expect(failed).toMatchObject({ status: 'failed', tenantId: A });
    expect(failed.error).toContain('failed after its write');
    expect((await pool.query('select count(*)::int as n from app.fixture_issues')).rows[0].n).toBe(
      before,
    );
    const self = await routing.route({ source: 'form', ref: `self-${Date.now()}`, text: '#self' });
    expect(self).toMatchObject({ status: 'failed' });
    expect(self.error).toContain("platform's own business");
    await expect(routing.route({ source: 'Bad Source', ref: 'x' })).rejects.toThrow();
  });

  it('a routed write the rules refuse fails the delivery, and the refusal is audited once', async () => {
    const routing = server.app?.get(PlatformRoutingService, {
      strict: false,
    }) as PlatformRoutingService;
    const refused = async () =>
      (await audits(A, 'issue.create')).filter((a) => a.rule === 'fixture_issue_refused');
    const before = (await refused()).length;
    const failed = await routing.route({
      source: 'form',
      ref: `refused-${Date.now()}`,
      text: 'Please #acme #refused',
    });
    expect(failed).toMatchObject({ status: 'failed', tenantId: A });
    const after = await refused();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ outcome: 'denied', actor_kind: 'system' });
  });

  it('operators read the routing log', async () => {
    const log = (await root.call('GET', '/api/platform/routing?status=failed')).body;
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log.every((r: { status: string }) => r.status === 'failed')).toBe(true);
    expect((await usher.call('GET', '/api/platform/routing')).body.rule).toBe(
      'operator_capability',
    );
  });
});

describe('usage across businesses', () => {
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    for (const [tenant, quantity, cost] of [
      [A, 1200, 30],
      [A, 800, 20],
      [B, 50, 5],
    ] as const)
      await pool.query(
        `insert into app.usage_events (tenant_id, meter, quantity, cost, currency, period_start, source)
         values ($1, 'tokens', $2, $3, 'XXX', date_trunc('month', now()), 'turn')`,
        [tenant, quantity, cost],
      );
    await pool.query(
      `insert into app.credit_wallets (tenant_id, currency, balance) values ($1, 'XXX', 450)
       on conflict (tenant_id) do update set balance = 450`,
      [A],
    );
    await pool.query(
      `insert into app.credit_ledger (tenant_id, kind, amount, balance_after, currency, actor_kind, actor_id)
       values ($1, 'topup', 500, 500, 'XXX', 'system', 'test'), ($1, 'debit', -50, 450, 'XXX', 'system', 'test')`,
      [A],
    );
  });

  it('sums each business’s meters and its wallet over the range, as recorded', async () => {
    const res = await usher.call(
      'GET',
      `/api/platform/usage?from=${day(-1)}&to=${day(1)}&tenantId=${A}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.tenants).toEqual([
      expect.objectContaining({
        tenantId: A,
        meters: [{ meter: 'tokens', quantity: 2000, cost: 50 }],
        wallet: { currency: 'XXX', balance: 450, topups: 500, grants: 0, debits: 50 },
      }),
    ]);
    expect(res.body.totals).toEqual([{ meter: 'tokens', quantity: 2000, cost: 50 }]);
    // B by id: the report pages by business id, so no one page need hold B.
    const onlyB = (
      await usher.call('GET', `/api/platform/usage?from=${day(-1)}&to=${day(1)}&tenantId=${B}`)
    ).body;
    expect(onlyB.tenants).toEqual([
      expect.objectContaining({
        tenantId: B,
        meters: [{ meter: 'tokens', quantity: 50, cost: 5 }],
        wallet: null,
      }),
    ]);
    // A range in the past has none of it.
    const old = (
      await usher.call('GET', `/api/platform/usage?from=2020-01-01&to=2020-02-01&tenantId=${A}`)
    ).body;
    expect(old.tenants[0].meters).toEqual([]);
  });

  it('pages by business; refuses a range backwards or over a year', async () => {
    const first = (await usher.call('GET', '/api/platform/usage?limit=1')).body;
    expect(first.tenants).toHaveLength(1);
    expect(first.next).toEqual(expect.any(String));
    const second = (await usher.call('GET', `/api/platform/usage?limit=1&after=${first.next}`))
      .body;
    expect(second.tenants[0].tenantId > first.next).toBe(true);
    expect(
      (await usher.call('GET', `/api/platform/usage?from=${day(1)}&to=${day(-1)}`)).status,
    ).toBe(400);
    expect(
      (await usher.call('GET', '/api/platform/usage?from=2020-01-01&to=2022-01-01')).status,
    ).toBe(400);
    expect((await helper.call('GET', '/api/platform/usage')).body.rule).toBe('operator_capability');
  });
});

describe('the job queues', () => {
  /** What Bull Board's gate answers this person (it is mounted before the API listens). */
  const gate = async (person?: Person) => {
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      send() {
        return this;
      },
    };
    const req = { headers: person ? { cookie: person.cookie } : {} };
    // Imported here: it loads the server's configuration, which the env above must reach first.
    const { onlyOperators } = await import('../../dist/channels/admin/bull-board.js');
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in for Express's request and response
    await onlyOperators(req as any, res as any, () => {});
    return status;
  };

  it('Bull Board is for operators holding platform.queues, never a business’s owner', async () => {
    expect(await gate()).toBe(401);
    expect(await gate(ana)).toBe(403);
    expect(await gate(usher)).toBe(403);
    expect(await gate(root)).toBe(200);
  });
});
