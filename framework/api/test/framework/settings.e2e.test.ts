// A business's setup (A11): feature flags that fail closed, custom fields, branding and verified
// custom domains, the business's wording, and platform-scoped shared records. The fixture's
// settings feature adds a `gadgets` module (custom fields, shared) and an `extras` module (switched
// as a whole by a flag): fixture/src/features/settings.
import { configureSharedRecords } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customDomainsAuth } from '../../dist/features/settings/domains.js';
import { SettingsTurnHook } from '../../dist/features/settings/turn.js';
import { FeatureFlagsService } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  server,
  shutdown,
  stamp,
} from '../../dist/testing.js';
import { setTxtResolver } from '../../dist/testing-internals.js';
import { settingsApp } from '../fixture/dist/features/settings/index.js';

const owner = new Person('Owner Settings');
const staff = new Person('Staff Settings');
const admin = new Person('Admin Settings');
const other = new Person('Other Settings');
const curator = new Person('Curator Settings');
const third = new Person('Third Settings');
let tenantId = '';
let otherTenant = '';
let platform = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const flags = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(FeatureFlagsService, { strict: false }) as FeatureFlagsService;
};
const turnHook = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(SettingsTurnHook, { strict: false }) as SettingsTurnHook;
};
const turnFor = async (person: Person, tenant: string) =>
  turnHook().before({
    kind: 'chat',
    principal: {
      actor: { kind: 'user', id: person.id },
      subject: { kind: 'user', userId: person.id },
      tenantId: tenant,
      roles: ['owner'],
      scopes: [],
    },
    runId: 'r1',
    message: 'hello',
    channel: 'app',
    surfaces: ['inline'],
  });

const audit = async (action: string, tenant = tenantId) =>
  (
    await pool.query(
      'select action, outcome, rule, actor_kind, after from audit.events where action = $1 and tenant_id = $2 order by at',
      [action, tenant],
    )
  ).rows;

beforeAll(async () => {
  await boot(settingsApp);
  for (const p of [owner, staff, admin, other, curator, third]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  otherTenant = (await me(other)).tenantId;
  platform = (await me(curator)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(admin, tenantId, ['admin']);
});
afterAll(async () => {
  setTxtResolver(undefined);
  configureSharedRecords({ platformTenantId: undefined });
  await shutdown();
});

describe('feature flags', () => {
  it('are off until a business switches them on: its routes are 404, like a missing record', async () => {
    expect((await me(owner)) as unknown).toMatchObject({ features: [] });
    const list = await owner.call('GET', '/api/extras');
    expect(list.status).toBe(404);
    expect(list.body).toMatchObject({ error: 'not_found' });
    expect((await owner.call('POST', '/api/extras', { title: 'Nope' })).status).toBe(404);
    const { rows } = await pool.query(
      'select count(*)::int as n from app.fixture_extras where tenant_id = $1',
      [tenantId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('lists the declared flags, with their state and who switches them', async () => {
    const res = await owner.call('GET', '/api/features');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'extras.all', managedBy: 'tenant', on: false }),
        expect.objectContaining({
          key: 'gadgets.polish',
          managedBy: 'platform',
          on: false,
          gates: expect.objectContaining({ commands: ['gadget.polish'] }),
        }),
      ]),
    );
  });

  it('a business-managed flag is switched by settings.manage only, through the write path', async () => {
    const refused = await staff.call('PUT', '/api/features/extras.all', { on: true }, inTenant());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'needs_settings_manage' });
    expect((await owner.call('PUT', '/api/features/no.such', { on: true })).status).toBe(404);
    const on = await owner.call('PUT', '/api/features/extras.all', { on: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ status: 'done', value: { key: 'extras.all', on: true } });
    expect(await audit('settings.feature')).toContainEqual(
      expect.objectContaining({ outcome: 'committed', actor_kind: 'user' }),
    );
    expect(await audit('settings.feature')).toContainEqual(
      expect.objectContaining({ outcome: 'denied', rule: 'needs_settings_manage' }),
    );
    expect(((await me(owner)) as unknown as { features: string[] }).features).toEqual([
      'extras.all',
    ]);
    expect((await owner.call('GET', '/api/extras')).status).toBe(200);
    expect((await owner.call('POST', '/api/extras', { title: 'Now on' })).status).toBe(201);
    // Another business still has it off.
    expect((await other.call('GET', '/api/extras')).status).toBe(404);
  });

  it('a platform-managed flag is refused over HTTP; server code switches it as the system', async () => {
    const gadget = await owner.call('POST', '/api/gadgets', { title: 'Lamp' });
    expect(gadget.status).toBe(201);
    const id = gadget.body.value.id;
    expect((await owner.call('POST', `/api/gadgets/${id}/polish`, {})).status).toBe(404);
    const refused = await owner.call('PUT', '/api/features/gadgets.polish', { on: true });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'platform_managed' });
    await flags().set(tenantId, 'gadgets.polish', true);
    expect(await audit('settings.feature')).toContainEqual(
      expect.objectContaining({ outcome: 'committed', actor_kind: 'system' }),
    );
    const polished = await owner.call('POST', `/api/gadgets/${id}/polish`, {});
    expect(polished.status).toBe(200);
    expect(polished.body.value.title).toBe('Lamp (polished)');
  });

  it('a command that writes a switched-off entity is rolled back with 404, whatever its own module', async () => {
    const gadget = await other.call('POST', '/api/gadgets', { title: 'Kettle' });
    const id = gadget.body.value.id;
    const res = await other.call('POST', `/api/gadgets/${id}/spawn-extra`, {});
    expect(res.status).toBe(404);
    const { rows } = await pool.query(
      'select count(*)::int as n from app.fixture_extras where tenant_id = $1',
      [otherTenant],
    );
    expect(rows[0].n).toBe(0);
    // With extras on in its own business, the same command writes.
    const ok = await owner.call(
      'POST',
      `/api/gadgets/${(await owner.call('POST', '/api/gadgets', { title: 'Fan' })).body.value.id}/spawn-extra`,
      {},
    );
    expect(ok.status).toBe(200);
  });

  it('a write parked while on, approved after the flag went off, fails instead of running', async () => {
    const agent = asAssistant(`user:${owner.id}`, { 'x-tenant-id': tenantId });
    const parked = await agent('POST', '/api/extras', { title: 'Parked extra' });
    expect(parked.body).toMatchObject({ status: 'needs_approval' });
    expect(await audit('extra.create')).toContainEqual(
      expect.objectContaining({ outcome: 'needs_approval' }),
    );
    await owner.call('PUT', '/api/features/extras.all', { on: false });
    const decided = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(decided.body).toMatchObject({ status: 'failed' });
    const { rows } = await pool.query(
      "select count(*)::int as n from app.fixture_extras where title = 'Parked extra'",
    );
    expect(rows[0].n).toBe(0);
  });

  it("takes switched-off things' tools away from the assistant for the turn", async () => {
    const off = await turnFor(owner, otherTenant);
    expect(off?.withoutTools).toEqual(
      expect.arrayContaining(['list-extras', 'create-extra', 'delete-extra', 'polish-gadget']),
    );
    expect(off?.withoutTools).not.toContain('list-gadgets');
    await owner.call('PUT', '/api/features/extras.all', { on: true });
    const on = await turnFor(owner, tenantId);
    expect(on?.withoutTools ?? []).not.toContain('list-extras');
    expect(on?.withoutTools ?? []).not.toContain('polish-gadget');
    // The agent's own call to a switched-off route is the same 404.
    const agent = asAssistant(`user:${other.id}`, { 'x-tenant-id': otherTenant });
    expect((await agent('GET', '/api/extras')).status).toBe(404);
  });

  it('GET /api/settings says what is off, for the apps', async () => {
    const res = await other.call('GET', '/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.features).toEqual([]);
    expect(res.body.off).toMatchObject({
      modules: ['extras'],
      nav: ['/extras'],
      commands: ['gadget.polish'],
    });
  });
});

describe('custom fields', () => {
  let priorityId = '';

  it('settings.manage defines a business’s fields; types, entities and options are checked', async () => {
    const field = {
      entity: 'gadget',
      key: 'priority',
      type: 'select',
      label: { en: 'Priority' },
      options: ['low', 'medium', 'high'],
    };
    const refused = await staff.call('POST', '/api/custom-fields', field, inTenant());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'needs_settings_manage' });
    const made = await owner.call('POST', '/api/custom-fields', field);
    expect(made.status).toBe(201);
    priorityId = made.body.value.id;
    expect(made.body.value).toMatchObject({ key: 'priority', type: 'select', filterable: true });
    const estimate = await owner.call('POST', '/api/custom-fields', {
      entity: 'gadget',
      key: 'estimate',
      type: 'number',
      label: { en: 'Estimate', hi: 'अनुमान' },
    });
    expect(estimate.status).toBe(201);
    const bad = async (body: object) =>
      (await owner.call('POST', '/api/custom-fields', { label: { en: 'X' }, ...body })).body.rule;
    expect(await bad({ entity: 'gadget', key: 'shade', type: 'colour' })).toBe(
      'unknown_field_type',
    );
    expect(await bad({ entity: 'task', key: 'shade', type: 'text' })).toBe('no_custom_fields');
    expect(await bad({ entity: 'gadget', key: 'shade', type: 'select' })).toBe('needs_options');
    expect(await bad({ entity: 'gadget', key: 'shade', type: 'text', options: ['a'] })).toBe(
      'no_options',
    );
    const twice = await owner.call('POST', '/api/custom-fields', field);
    expect(twice.status).toBe(409);
    const badKey = await owner.call('POST', '/api/custom-fields', { ...field, key: 'in' });
    expect(badKey.status).toBe(400);
  });

  it("another business never sees or changes a business's fields", async () => {
    expect((await other.call('GET', `/api/custom-fields/${priorityId}`)).status).toBe(404);
    expect(
      (await other.call('PATCH', `/api/custom-fields/${priorityId}`, { required: true })).status,
    ).toBe(404);
    expect((await other.call('GET', '/api/custom-fields?entity=gadget')).body.items).toEqual([]);
    const mine = await staff.call('GET', '/api/custom-fields?entity=gadget', undefined, inTenant());
    expect(mine.body.items.map((f: { key: string }) => f.key)).toEqual(['priority', 'estimate']);
  });

  it('values are checked against the definitions; a bad one rolls the write back', async () => {
    const ok = await owner.call('POST', '/api/gadgets', {
      title: 'Desk',
      custom: { priority: 'high', estimate: 3 },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.value.custom).toEqual({ priority: 'high', estimate: 3 });
    const wrong = await owner.call('POST', '/api/gadgets', {
      title: 'Chair',
      custom: { priority: 'urgent' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: 'custom_field_invalid' });
    const unknown = await owner.call('POST', '/api/gadgets', {
      title: 'Chair',
      custom: { colour: 'red' },
    });
    expect(unknown.status).toBe(400);
    const { rows } = await pool.query(
      "select count(*)::int as n from app.fixture_gadgets where title = 'Chair'",
    );
    expect(rows[0].n).toBe(0);
    // Another business has no such field.
    expect(
      (await other.call('POST', '/api/gadgets', { title: 'Sofa', custom: { priority: 'high' } }))
        .status,
    ).toBe(400);
  });

  it('an update merges into the stored values; null removes one', async () => {
    const made = await owner.call('POST', '/api/gadgets', {
      title: 'Shelf',
      custom: { priority: 'low' },
    });
    const id = made.body.value.id;
    const merged = await owner.call('PATCH', `/api/gadgets/${id}`, { custom: { estimate: 5 } });
    expect(merged.body.value.custom).toEqual({ priority: 'low', estimate: 5 });
    const removed = await owner.call('PATCH', `/api/gadgets/${id}`, { custom: { priority: null } });
    expect(removed.body.value.custom).toEqual({ estimate: 5 });
  });

  it('lists filter on custom fields by the stored type; an undefined key is a 400', async () => {
    const titles = async (q: string) =>
      (await owner.call('GET', `/api/gadgets?${q}`)).body.items
        .map((g: { title: string }) => g.title)
        .sort();
    expect(await titles('custom[priority]=high')).toEqual(['Desk']);
    expect(
      await titles(`custom=${encodeURIComponent(JSON.stringify({ estimate: { gte: 4 } }))}`),
    ).toEqual(['Shelf']);
    expect(
      await titles(
        `custom=${encodeURIComponent(JSON.stringify({ priority: { in: ['high', 'low'] } }))}`,
      ),
    ).toEqual(['Desk']);
    expect(
      await titles(`custom=${encodeURIComponent(JSON.stringify({ estimate: { lt: 4 } }))}`),
    ).toEqual(['Desk']);
    const unknown = await owner.call('GET', '/api/gadgets?custom[colour]=red');
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: 'unknown_custom_field' });
  });

  it("a parked write's values are checked when it parks, and the park is audited with them", async () => {
    const agent = asAssistant(`user:${owner.id}`, { 'x-tenant-id': tenantId });
    const bad = await agent('POST', '/api/gadgets', {
      title: 'Bad park',
      custom: { priority: 'urgent' },
    });
    expect(bad.status).toBe(400);
    const parked = await agent('POST', '/api/gadgets', {
      title: 'Good park',
      custom: { priority: 'medium' },
    });
    expect(parked.body).toMatchObject({ status: 'needs_approval' });
    const approval = await owner.call('GET', `/api/approvals/${parked.body.approval.id}`);
    expect(approval.body.input).toMatchObject({ custom: { priority: 'medium' } });
    expect(await audit('gadget.create')).toContainEqual(
      expect.objectContaining({ outcome: 'needs_approval' }),
    );
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
  });

  it('a required field is needed on create and when custom values change, not otherwise', async () => {
    const old = await owner.call('POST', '/api/gadgets', { title: 'Old one' });
    const code = await owner.call('POST', '/api/custom-fields', {
      entity: 'gadget',
      key: 'code',
      type: 'text',
      label: { en: 'Code' },
      required: true,
    });
    expect(code.status).toBe(201);
    expect((await owner.call('POST', '/api/gadgets', { title: 'No code' })).status).toBe(400);
    expect(
      (await owner.call('PATCH', `/api/gadgets/${old.body.value.id}`, { title: 'Old, renamed' }))
        .status,
    ).toBe(200);
    expect(
      (await owner.call('PATCH', `/api/gadgets/${old.body.value.id}`, { custom: { estimate: 1 } }))
        .status,
    ).toBe(400);
    expect((await owner.call('DELETE', `/api/custom-fields/${code.body.value.id}`)).status).toBe(
      200,
    );
  });

  it('a value kept from a removed field stays until someone changes or clears it', async () => {
    const size = await owner.call('POST', '/api/custom-fields', {
      entity: 'gadget',
      key: 'size',
      type: 'text',
      label: { en: 'Size' },
    });
    expect(size.status).toBe(201);
    const made = await owner.call('POST', '/api/gadgets', {
      title: 'Lamp',
      custom: { size: 'big' },
    });
    expect(made.status).toBe(201);
    const id = made.body.value.id;
    expect((await owner.call('DELETE', `/api/custom-fields/${size.body.value.id}`)).status).toBe(
      200,
    );
    const changed = await owner.call('PATCH', `/api/gadgets/${id}`, { custom: { estimate: 2 } });
    expect(changed.status).toBe(200);
    expect(changed.body.value.custom).toEqual({ size: 'big', estimate: 2 });
    const reset = await owner.call('PATCH', `/api/gadgets/${id}`, { custom: { size: 'small' } });
    expect(reset.status).toBe(400);
    expect(reset.body).toMatchObject({ error: 'custom_field_invalid' });
    const cleared = await owner.call('PATCH', `/api/gadgets/${id}`, { custom: { size: null } });
    expect(cleared.body.value.custom).toEqual({ estimate: 2 });
  });

  it('tells the assistant the business’s fields for the turn', async () => {
    const shape = await turnFor(owner, tenantId);
    expect(shape?.context?.join('\n')).toContain(
      'priority (select: low, medium, high, filterable)',
    );
    const none = await turnFor(other, otherTenant);
    expect(none?.context ?? []).toEqual([]);
  });
});

describe('branding and wording', () => {
  it('settings.manage changes the branding; others read it; colours and addresses are checked', async () => {
    const refused = await staff.call(
      'PATCH',
      '/api/settings/branding',
      { name: 'Nope' },
      inTenant(),
    );
    expect(refused.status).toBe(403);
    expect(
      (await owner.call('PATCH', '/api/settings/branding', { colors: { primary: 'blue' } })).status,
    ).toBe(400);
    expect(
      (await owner.call('PATCH', '/api/settings/branding', { logoUrl: 'http://example.com/a.png' }))
        .status,
    ).toBe(400);
    const res = await owner.call('PATCH', '/api/settings/branding', {
      name: 'Acme',
      logoUrl: 'https://cdn.example.com/acme.png',
      colors: { primary: '#112233' },
    });
    expect(res.status).toBe(200);
    expect(res.body.value).toMatchObject({
      name: 'Acme',
      colors: { primary: '#112233', rail: null },
    });
    const seen = await staff.call('GET', '/api/settings', undefined, inTenant());
    expect(seen.body.branding).toMatchObject({
      name: 'Acme',
      logoUrl: 'https://cdn.example.com/acme.png',
    });
    expect((await other.call('GET', '/api/settings')).body.branding).toMatchObject({ name: null });
    // A patch changes only what it sends.
    await owner.call('PATCH', '/api/settings/branding', { colors: { rail: '#eeeeee' } });
    expect((await owner.call('GET', '/api/settings')).body.branding.colors).toEqual({
      primary: '#112233',
      primaryText: null,
      rail: '#eeeeee',
    });
    expect(await audit('settings.branding')).toContainEqual(
      expect.objectContaining({ outcome: 'committed' }),
    );
  });

  it("the business's own phrases keep their placeholders; unknown phrases and notifications are refused", async () => {
    const res = await owner.call('PATCH', '/api/settings/wording', {
      phrases: { 'channel.handoff': { en: 'Our team answers within {replyTime}.' } },
    });
    expect(res.status).toBe(200);
    expect((await staff.call('GET', '/api/settings', undefined, inTenant())).body.phrases).toEqual({
      'channel.handoff': { en: 'Our team answers within {replyTime}.' },
    });
    const lost = await owner.call('PATCH', '/api/settings/wording', {
      phrases: { 'channel.handoff': { en: 'Our team answers soon.' } },
    });
    expect(lost.status).toBe(400);
    expect(
      (await owner.call('PATCH', '/api/settings/wording', { phrases: { 'no.such': { en: 'x' } } }))
        .status,
    ).toBe(400);
    expect(
      (
        await owner.call('PATCH', '/api/settings/wording', {
          notifications: { 'no.such': { email: { subject: { en: 'x' } } } },
        })
      ).status,
    ).toBe(400);
    const { tenantPhrase } = await import('@hykr/contracts');
    const settings = { wording: { phrases: { 'channel.handoff': { en: 'Within {replyTime}.' } } } };
    expect(tenantPhrase(settings, 'en', 'channel.handoff', { replyTime: '1 hour' })).toBe(
      'Within 1 hour.',
    );
    expect(tenantPhrase(settings, 'hi', 'channel.handoff', { replyTime: '1' })).not.toBe(
      'Within 1.',
    );
  });
});

describe('custom domains', () => {
  const origin = `https://a11-${stamp}.example.com`;
  let id = '';
  const dns = new Map<string, string[][]>();

  beforeAll(() => setTxtResolver(async (name) => dns.get(name) ?? []));

  it('a business adds an address; it is trusted only once its TXT record holds the token', async () => {
    const added = await owner.call('POST', '/api/settings/domains', { origin });
    expect(added.status).toBe(200);
    id = added.body.value.id;
    const { record, verified } = added.body.value;
    expect(verified).toBe(false);
    expect(record.name).toBe(`_basecamp-verify.a11-${stamp}.example.com`);
    expect(await customDomainsAuth.originAllowed?.(origin)).toBe(false);
    const early = await owner.call('POST', `/api/settings/domains/${id}/verify`, {});
    expect(early.status).toBe(400);
    expect(early.body).toMatchObject({ error: 'domain_not_verified' });
    dns.set(record.name, [[record.value]]);
    const verifiedNow = await owner.call('POST', `/api/settings/domains/${id}/verify`, {});
    expect(verifiedNow.body.value).toMatchObject({ verified: true });
    expect(await customDomainsAuth.originAllowed?.(origin)).toBe(true);
  });

  it('CORS and sign-in trust the verified origin, and the sign-in screen gets its branding', async () => {
    const preflight = await fetch(`${server.base}/api/me`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    const stranger = await fetch(`${server.base}/api/me`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
    const init = customDomainsAuth.plugin?.init?.({} as never) as {
      options: { trustedOrigins: (r: Request) => Promise<string[]> };
    };
    expect(
      await init.options.trustedOrigins(new Request(server.base, { headers: { origin } })),
    ).toEqual([origin]);
    expect(
      await init.options.trustedOrigins(
        new Request(server.base, { headers: { origin: 'https://evil.example.com' } }),
      ),
    ).toEqual([]);
    const brand = await fetch(`${server.base}/api/branding/public`, { headers: { origin } });
    expect(brand.status).toBe(200);
    expect(await brand.json()).toMatchObject({ name: 'Acme', colors: { primary: '#112233' } });
    const none = await fetch(`${server.base}/api/branding/public`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(none.status).toBe(404);
  });

  it("one origin belongs to one business; another business cannot see or touch a business's domain", async () => {
    const taken = await other.call('POST', '/api/settings/domains', { origin });
    expect(taken.status).toBe(409);
    const verify = await other.call('POST', `/api/settings/domains/${id}/verify`, {});
    expect({ status: verify.status, body: verify.body }).toMatchObject({ status: 404 });
    expect((await other.call('DELETE', `/api/settings/domains/${id}`, {})).status).toBe(404);
    expect((await other.call('GET', '/api/settings/domains')).body).toEqual([]);
    expect((await staff.call('GET', '/api/settings/domains', undefined, inTenant())).status).toBe(
      403,
    );
    expect(
      (await owner.call('POST', '/api/settings/domains', { origin: 'https://*.example.com' }))
        .status,
    ).toBe(400);
  });

  it('a pending claim squats nothing: the first business to verify holds the address', async () => {
    const contested = `https://a11-contested-${stamp}.example.com`;
    const early = await other.call('POST', '/api/settings/domains', { origin: contested });
    expect(early.status).toBe(200);
    const mine = await owner.call('POST', '/api/settings/domains', { origin: contested });
    expect(mine.status).toBe(200);
    expect((await owner.call('POST', '/api/settings/domains', { origin: contested })).status).toBe(
      409,
    );
    const { record } = mine.body.value;
    dns.set(record.name, [[record.value]]);
    const verified = await owner.call(
      'POST',
      `/api/settings/domains/${mine.body.value.id}/verify`,
      {},
    );
    expect(verified.body.value).toMatchObject({ verified: true });
    const late = await other.call(
      'POST',
      `/api/settings/domains/${early.body.value.id}/verify`,
      {},
    );
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'domain_taken' });
    expect(await customDomainsAuth.originAllowed?.(contested)).toBe(true);
    const brand = await fetch(`${server.base}/api/branding/public?origin=${contested}`);
    expect(await brand.json()).toMatchObject({ name: 'Acme' });
  });

  it('a removed address is no longer trusted', async () => {
    expect((await owner.call('DELETE', `/api/settings/domains/${id}`, {})).status).toBe(200);
    expect(await customDomainsAuth.originAllowed?.(origin)).toBe(false);
  });
});

describe('shared records', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    configureSharedRecords({ platformTenantId: platform });
    for (const [title, rank] of [
      ['Shared A', 101],
      ['Shared C', 103],
    ] as const)
      ids[title] = (await curator.call('POST', '/api/gadgets', { title, rank })).body.value.id;
    ids.own = (
      await admin.call('POST', '/api/gadgets', { title: 'Own B', rank: 102 }, inTenant())
    ).body.value.id;
  });

  const listed = async (
    person: Person,
    q = 'rank[gte]=100',
    headers: Record<string, string> = {},
  ) => {
    const res = await person.call('GET', `/api/gadgets?${q}`, undefined, headers);
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 200 });
    return res.body;
  };

  it("every business reads the platform's rows with its own, in one order", async () => {
    const page = await listed(admin, 'rank[gte]=100&count=true', inTenant());
    expect(page.items.map((g: { title: string; shared: boolean }) => [g.title, g.shared])).toEqual([
      ['Shared A', true],
      ['Own B', false],
      ['Shared C', true],
    ]);
    expect(page.total).toBe(3);
    const first = await listed(admin, 'rank[gte]=100&limit=2', inTenant());
    expect(first.items.map((g: { title: string }) => g.title)).toEqual(['Shared A', 'Own B']);
    const rest = await listed(
      admin,
      `rank[gte]=100&limit=2&cursor=${first.nextCursor}`,
      inTenant(),
    );
    expect(rest.items.map((g: { title: string }) => g.title)).toEqual(['Shared C']);
    expect(rest.nextCursor).toBeNull();
    expect(
      (await admin.call('GET', `/api/gadgets/${ids['Shared A']}`, undefined, inTenant())).body,
    ).toMatchObject({ shared: true });
  });

  it("a business's own rows stay its own; the platform reads only its own", async () => {
    expect((await listed(third)).items.map((g: { title: string }) => g.title)).toEqual([
      'Shared A',
      'Shared C',
    ]);
    expect((await third.call('GET', `/api/gadgets/${ids.own}`)).status).toBe(404);
    expect((await listed(curator)).items.map((g: { title: string }) => g.title)).toEqual([
      'Shared A',
      'Shared C',
    ]);
  });

  it('a platform row leaves projected for the reader: a field hidden from staff stays hidden', async () => {
    const page = await listed(staff, 'rank[gte]=100', inTenant());
    expect(page.items.map((g: { title: string }) => g.title)).toEqual(['Shared A', 'Shared C']);
    for (const item of page.items) expect(item).not.toHaveProperty('rank');
    const one = await staff.call('GET', `/api/gadgets/${ids['Shared A']}`, undefined, inTenant());
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ title: 'Shared A', shared: true });
    expect(one.body).not.toHaveProperty('rank');
    // The admin of the same business sees it.
    expect(
      (await admin.call('GET', `/api/gadgets/${ids['Shared A']}`, undefined, inTenant())).body,
    ).toMatchObject({ rank: 101 });
  });

  it('a platform row is read-only to every other business', async () => {
    const changed = await admin.call(
      'PATCH',
      `/api/gadgets/${ids['Shared A']}`,
      { title: 'Mine now' },
      inTenant(),
    );
    expect(changed.status).toBe(403);
    expect(changed.body).toMatchObject({ rule: 'shared_read_only' });
    expect(
      (await admin.call('DELETE', `/api/gadgets/${ids['Shared A']}`, undefined, inTenant())).status,
    ).toBe(403);
    const { rows } = await pool.query('select title from app.fixture_gadgets where id = $1', [
      ids['Shared A'],
    ]);
    expect(rows[0].title).toBe('Shared A');
  });

  it('a business overrides a platform row once, and then reads its own instead', async () => {
    const made = await admin.call(
      'POST',
      '/api/gadgets',
      { title: 'Shared A, ours', rank: 101, sharedId: ids['Shared A'] },
      inTenant(),
    );
    expect(made.status).toBe(201);
    expect(made.body.value).toMatchObject({ sharedId: ids['Shared A'], shared: false });
    expect(
      (await listed(admin, 'rank[gte]=100', inTenant())).items.map(
        (g: { title: string }) => g.title,
      ),
    ).toEqual(['Shared A, ours', 'Own B', 'Shared C']);
    const again = await admin.call(
      'POST',
      '/api/gadgets',
      { title: 'Twice', rank: 1, sharedId: ids['Shared A'] },
      inTenant(),
    );
    expect(again.status).toBe(409);
    const ownRow = await admin.call(
      'POST',
      '/api/gadgets',
      { title: 'Self', rank: 1, sharedId: ids.own },
      inTenant(),
    );
    expect(ownRow.status).toBe(400);
    // Another business still reads the platform's row.
    expect((await listed(third)).items.map((g: { title: string }) => g.title)).toEqual([
      'Shared A',
      'Shared C',
    ]);
  });

  it('without a platform business configured, nothing is shared', async () => {
    configureSharedRecords({ platformTenantId: undefined });
    expect((await listed(third)).items).toEqual([]);
    configureSharedRecords({ platformTenantId: platform });
  });
});
