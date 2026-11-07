// Identity (F4): roles and capabilities instead of hard-coded role names, the agent identity
// provider chain, the system principal, a business's cached settings, and auth plugins with
// their origins. The fixture's src/features/identity adds a role, a capability, a bearer
// identity provider and an auth plugin.
import { randomUUID } from 'node:crypto';
import { FrameworkCapabilities } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  entityOp,
  runWrite,
  systemPrincipal,
  TenantConfigService,
} from '@hykr/core';
import { can } from '@hykr/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOrigin, corsOrigins, getAuth, trustedOrigins } from '../../dist/infra/auth.js';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  seedContact,
  server,
  shutdown,
} from '../../dist/testing.js';
import { fixtureTokens, identity } from '../fixture/dist/features/identity/index.js';
import { Task } from '../fixture/dist/server.js';

const ana = new Person('Ana Identity');
const ops = new Person('Ops Identity');
const staffer = new Person('Staff Identity');
const auditor = new Person('Auditor Identity');
const wizard = new Person('Wizard Identity');
const stranger = new Person('Stranger Identity');
let tenantId = '';
let strangerTenant = '';

/** A person's calls inside Ana's business. */
const inAna = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });

/** Calls with a bearer token, as an MCP client makes them: no session cookie. */
const withToken =
  (token: string, headers: Record<string, string> = {}) =>
  async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

const audit = async (action: string, resourceId: string) =>
  (
    await pool.query(
      `select actor_kind, actor_id, acting_for, tenant_id, channel, run_id, outcome
       from audit.events where action = $1 and resource_id = $2 order by at`,
      [action, resourceId],
    )
  ).rows;

beforeAll(async () => {
  await boot(identity);
  for (const p of [ana, ops, staffer, auditor, wizard, stranger]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  strangerTenant = (await me(stranger)).tenantId;
  await addMember(ops, tenantId, ['ops']);
  await addMember(staffer, tenantId, ['staff']);
  await addMember(auditor, tenantId, ['fixture_auditor']);
  // Neither is a registered role: 'Ops' is not 'ops'.
  await addMember(wizard, tenantId, ['wizard', 'Ops']);
});
afterAll(shutdown);

describe('roles and capabilities', () => {
  it('/api/me says what each role allows, the same as the old role checks', async () => {
    expect((await ana.call('GET', '/api/me')).body).toMatchObject({
      roles: ['owner'],
      capabilities: [
        'approvals.decide',
        'backoffice.use',
        'calendar.availability.read',
        'calls.read_all',
        'channels.manage',
        'comments.internal',
        'comments.moderate',
        'credits.manage',
        'credits.view',
        'customers.message',
        'data.export',
        'fixture.reports',
        'integrations.manage',
        'marketing.approve',
        'members.manage',
        'members.read',
        'memory.manage',
        'memory.read',
        'memory.write',
        'models.manage',
        'parties.manage',
        'parties.read',
        'queues.admin',
        'records.grant',
        'settings.manage',
      ],
    });
    expect((await inAna(ops)('GET', '/api/me')).body.capabilities).toEqual([
      'approvals.decide',
      'backoffice.use',
      'calendar.availability.read',
      'comments.internal',
      'credits.view',
      'customers.message',
      'history.all',
      'members.read',
      'memory.read',
      'memory.write',
      'parties.manage',
      'parties.read',
      'records.grant',
    ]);
    expect((await inAna(staffer)('GET', '/api/me')).body.capabilities).toEqual([
      'backoffice.use',
      'comments.internal',
      'credits.view',
      'customers.message',
      'members.read',
      'memory.read',
      'memory.write',
      'parties.read',
    ]);
    // A role the application added, with the capability it names.
    expect((await inAna(auditor)('GET', '/api/me')).body).toMatchObject({
      roles: ['fixture_auditor'],
      capabilities: ['history.all'],
    });
  });

  it('a role nobody registered grants nothing: no capability, no rows', async () => {
    expect((await inAna(wizard)('GET', '/api/me')).body).toMatchObject({
      tenantId,
      roles: [],
      capabilities: [],
    });
    const task = (await ana.call('POST', '/api/tasks', { title: 'Wizard cannot see' })).body.value;
    expect((await inAna(wizard)('GET', `/api/tasks/${task.id}`)).status).toBe(404);
    expect((await inAna(wizard)('GET', '/api/tasks')).body.items).toEqual([]);
    expect((await inAna(wizard)('GET', '/api/backoffice/inbox')).status).toBe(403);
  });

  it('history: history.all sees the whole business, everyone else their own', async () => {
    const mine = (await inAna(staffer)('POST', '/api/tasks', { title: 'Staff task' })).body.value;
    const anas = (await ana.call('POST', '/api/tasks', { title: 'Owner task' })).body.value;
    const ids = async (p: Person) =>
      (await inAna(p)('GET', '/api/history')).body.map((e: { resourceId: string }) => e.resourceId);
    expect(await ids(staffer)).toContain(mine.id);
    expect(await ids(staffer)).not.toContain(anas.id);
    expect(await ids(ops)).toEqual(expect.arrayContaining([mine.id, anas.id]));
    expect(await ids(auditor)).toEqual(expect.arrayContaining([mine.id, anas.id]));
  });

  it('the back office is for roles with backoffice.use', async () => {
    expect((await inAna(staffer)('GET', '/api/backoffice/inbox')).status).toBe(200);
    expect((await ana.call('GET', '/api/backoffice/inbox')).status).toBe(200);
    const refused = await inAna(auditor)('GET', '/api/backoffice/inbox');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'forbidden', rule: 'staff_only' });
  });

  it("only channels.manage sets the business's WhatsApp number", async () => {
    const res = await inAna(staffer)('POST', '/api/channels/whatsapp/number', {
      phoneNumberId: 'fixture-number',
    });
    expect(res.status).toBe(403);
  });
});

describe('agent identity providers', () => {
  const anaToken = `tok-ana-${randomUUID()}`;
  beforeAll(() => {
    fixtureTokens.set(anaToken, { userId: ana.id, tenantId });
  });

  it('a bearer token acts for its person, and audit names the agent, channel and run', async () => {
    const asMcp = withToken(anaToken);
    const made = await asMcp('POST', '/api/tasks', { title: 'From an MCP client' });
    expect(made.status).toBe(201);
    const id = made.body.value.id;
    expect(
      (await asMcp('GET', '/api/tasks')).body.items.map((t: { id: string }) => t.id),
    ).toContain(id);
    const [row] = await audit('task.create', id);
    expect(row).toMatchObject({
      actor_kind: 'agent',
      actor_id: 'fixture-mcp',
      acting_for: ana.id,
      tenant_id: tenantId,
      channel: 'mcp',
      outcome: 'committed',
    });
    // The credential had no run id: the guard made one, so the write is still traceable.
    expect(row.run_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a token the provider does not know is a 401, even with a session cookie', async () => {
    const res = await ana.call('GET', '/api/tasks', undefined, { authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });

  it("another business's rows stay a 404; a header cannot move the token's business", async () => {
    const theirs = (await stranger.call('POST', '/api/tasks', { title: 'Not Ana' })).body.value;
    expect((await withToken(anaToken)('GET', `/api/tasks/${theirs.id}`)).status).toBe(404);
    const moved = await withToken(anaToken, { 'x-tenant-id': strangerTenant })('GET', '/api/tasks');
    expect(moved.status).toBe(403);
    expect(moved.body).toMatchObject({ rule: 'tenant_mismatch' });
    // A token fixed to a business its person is not in is refused like the header would be.
    const elsewhere = `tok-elsewhere-${randomUUID()}`;
    fixtureTokens.set(elsewhere, { userId: ana.id, tenantId: strangerTenant });
    expect((await withToken(elsewhere)('GET', '/api/tasks')).status).toBe(403);
  });

  it('a contact of another business is refused, never acted for in that business', async () => {
    const address = () => `9198${Math.floor(Math.random() * 1e8)}`;
    const theirs = await seedContact(strangerTenant, 'Stranger Customer', address());
    // A credential fixed to Ana's business, naming a contact of the stranger's.
    const fixedToAna = `tok-contact-${randomUUID()}`;
    fixtureTokens.set(fixedToAna, { contactId: theirs.contactId, tenantId });
    const refused = await withToken(fixedToAna)('GET', '/api/tasks');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'forbidden', rule: 'tenant_mismatch' });
    expect((await withToken(fixedToAna)('POST', '/api/tasks', { title: 'Not here' })).status).toBe(
      403,
    );
    // The agent key with a header naming Ana's business: the same.
    const viaKey = await asAssistant(`contact:${theirs.contactId}`, { 'x-tenant-id': tenantId })(
      'GET',
      '/api/tasks',
    );
    expect(viaKey.status).toBe(403);
    expect(viaKey.body).toMatchObject({ rule: 'tenant_mismatch' });
    // Linked to Ana, who does belong to Ana's business: still the stranger's contact, refused.
    const linked = await seedContact(strangerTenant, 'Linked Customer', address());
    await pool.query('update channel.contacts set user_id = $1, linked_at = now() where id = $2', [
      ana.id,
      linked.contactId,
    ]);
    const linkedToken = `tok-linked-${randomUUID()}`;
    fixtureTokens.set(linkedToken, { contactId: linked.contactId, tenantId });
    expect((await withToken(linkedToken)('GET', '/api/tasks')).body).toMatchObject({
      rule: 'tenant_mismatch',
    });
    await pool.query('update channel.contacts set user_id = null where id = $1', [
      linked.contactId,
    ]);

    // In its own business it works, writes are audited there, and Ana's rows stay a 404.
    const own = `tok-own-${randomUUID()}`;
    fixtureTokens.set(own, { contactId: theirs.contactId, tenantId: strangerTenant });
    const made = await withToken(own)('POST', '/api/tasks', { title: 'Their own' });
    expect(made.status).toBe(201);
    expect((await audit('task.create', made.body.value.id))[0]).toMatchObject({
      actor_kind: 'agent',
      acting_for: `contact:${theirs.contactId}`,
      tenant_id: strangerTenant,
      channel: 'mcp',
    });
    const anas = (await ana.call('POST', '/api/tasks', { title: 'Ana only' })).body.value;
    expect((await withToken(own)('GET', `/api/tasks/${anas.id}`)).status).toBe(404);
  });

  it('a provider cannot pass as a configured agent, or send a bad run id', async () => {
    const posing = `tok-posing-${randomUUID()}`;
    fixtureTokens.set(posing, { userId: ana.id, agentId: 'assistant' });
    expect((await withToken(posing)('GET', '/api/tasks')).status).toBe(401);
    const badRun = `tok-badrun-${randomUUID()}`;
    fixtureTokens.set(badRun, { userId: ana.id, runId: 'no spaces allowed' });
    expect((await withToken(badRun)('GET', '/api/tasks')).status).toBe(401);
  });

  it('what is for people stays closed to it', async () => {
    const asMcp = withToken(anaToken);
    expect((await asMcp('GET', '/api/me')).status).toBe(403);
    expect((await asMcp('GET', '/api/history')).status).toBe(403);
    const visit = await ana.call('POST', '/api/visits', {
      title: 'People delete visits',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
    });
    const refused = await asMcp('DELETE', `/api/visits/${visit.body.value.id}`);
    expect(refused.status).toBe(403);
  });

  it('its delete parks for the person, and the park is audited', async () => {
    const asMcp = withToken(anaToken);
    const task = (await asMcp('POST', '/api/tasks', { title: 'Delete me later' })).body.value;
    const asked = await asMcp('DELETE', `/api/tasks/${task.id}`);
    expect(asked.body).toMatchObject({ status: 'needs_approval' });
    const parked = (await audit('task.delete', task.id)).find(
      (r) => r.outcome === 'needs_approval',
    );
    expect(parked).toMatchObject({ actor_kind: 'agent', actor_id: 'fixture-mcp', channel: 'mcp' });
    const approvals = (await ana.call('GET', '/api/approvals')).body;
    expect(approvals.find((a: { id: string }) => a.id === asked.body.approval.id)).toMatchObject({
      requestedBy: 'agent',
    });
  });

  it("the assistant forwards only a turn's channel", async () => {
    const asBackground = asAssistant(`user:${ana.id}`, { 'x-channel': 'background' });
    const made = await asBackground('POST', '/api/tasks', { title: 'Not background' });
    expect(made.status).toBe(201);
    expect((await audit('task.create', made.body.value.id))[0]).toMatchObject({
      actor_kind: 'agent',
      channel: null,
    });
  });
});

describe('the system principal', () => {
  const db = () => {
    const options = server.app?.get<CoreOptions>(CORE_OPTIONS, { strict: false });
    if (!options) throw new Error('The app is not booted');
    return options.db;
  };
  const write = (
    p: ReturnType<typeof systemPrincipal>,
    op: ReturnType<typeof entityOp>,
    input: unknown,
  ) => runWrite(db(), { principal: p, requestId: randomUUID() }, op, input);

  it('updates a row of its business through the write path, audited as system', async () => {
    const task = (await inAna(staffer)('POST', '/api/tasks', { title: 'Sweep me' })).body.value;
    const p = systemPrincipal({ tenantId, job: 'fixture.sweeper' });
    const out = await write(p, entityOp(Task, 'update', { id: task.id }), { title: 'Swept' });
    expect(out.result).toMatchObject({ status: 'done', value: { title: 'Swept' } });
    expect((await audit('task.update', task.id))[0]).toMatchObject({
      actor_kind: 'system',
      actor_id: 'fixture.sweeper',
      acting_for: null,
      tenant_id: tenantId,
      channel: 'background',
      run_id: p.runId,
    });
  });

  it("another business's row is not found, and it cannot create rows (no owner)", async () => {
    const task = (await ana.call('POST', '/api/tasks', { title: 'Not theirs' })).body.value;
    const elsewhere = systemPrincipal({ tenantId: strangerTenant, job: 'fixture.sweeper' });
    await expect(
      write(elsewhere, entityOp(Task, 'update', { id: task.id }), { title: 'Taken' }),
    ).rejects.toMatchObject({ status: 404 });
    const mine = systemPrincipal({ tenantId, job: 'fixture.sweeper' });
    await expect(
      write(mine, entityOp(Task, 'create', null), { title: 'Nobody owns this' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('only server code makes one: its options are checked, and no header makes one', async () => {
    expect(() => systemPrincipal({ tenantId: '', job: 'fixture.sweeper' })).toThrow('business');
    expect(() => systemPrincipal({ tenantId, job: 'Sweep It' })).toThrow('not a job name');
    expect(() => systemPrincipal({ tenantId, job: 'x', capabilities: ['nope.never'] })).toThrow(
      'unknown capability',
    );
    const sender = systemPrincipal({
      tenantId,
      job: 'fixture.reminders',
      capabilities: [FrameworkCapabilities.messageCustomers],
    });
    expect(can(sender, 'customers.message')).toBe(true);
    expect(can(systemPrincipal({ tenantId, job: 'x' }), 'customers.message')).toBe(false);
    // Headers that look like a system caller are only a caller without credentials.
    const res = await fetch(`${server.base}/api/tasks`, {
      headers: {
        'x-actor-kind': 'system',
        'x-agent-id': 'fixture.sweeper',
        'x-tenant-id': tenantId,
      },
    });
    expect(res.status).toBe(401);
  });
});

describe("a business's settings", () => {
  const config = () => server.app?.get(TenantConfigService) as TenantConfigService;
  const setFeatures = (features: unknown) =>
    pool.query(`update app.tenants set settings = settings || $2::jsonb where id = $1`, [
      tenantId,
      JSON.stringify({ features }),
    ]);

  it('features are off until switched on, and the settings are cached until invalidated', async () => {
    expect(await config().isEnabled(tenantId, 'fixture_beta')).toBe(false);
    await setFeatures({ fixture_beta: true });
    expect(await config().isEnabled(tenantId, 'fixture_beta')).toBe(false);
    config().invalidate(tenantId);
    expect(await config().isEnabled(tenantId, 'fixture_beta')).toBe(true);
    expect((await config().get(tenantId)).settings.features).toEqual({ fixture_beta: true });
  });

  it('fails closed: no business, an unknown one, or settings that do not parse', async () => {
    expect(await config().isEnabled(undefined, 'fixture_beta')).toBe(false);
    expect(await config().isEnabled('no-such-business', 'fixture_beta')).toBe(false);
    await setFeatures({ fixture_beta: 'yes' });
    config().invalidate(tenantId);
    expect(await config().isEnabled(tenantId, 'fixture_beta')).toBe(false);
    await expect(config().get(tenantId)).rejects.toThrow();
    await setFeatures({});
    config().invalidate();
  });
});

describe('auth plugins and origins', () => {
  it("Better Auth trusts a plugin's origins, and no others", async () => {
    // Better Auth skips its origin check when NODE_ENV is test, so ask the instance it built.
    const ctx = await getAuth().$context;
    expect(ctx.isTrustedOrigin('https://partner.example/welcome')).toBe(true);
    expect(ctx.isTrustedOrigin('fixturepartner://callback')).toBe(true);
    expect(ctx.isTrustedOrigin('https://evil.example/welcome')).toBe(false);
  });

  it("a plugin's own routes answer under /api/auth", async () => {
    const res = await fetch(`${server.base}/api/auth/fixture/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('origins are exact: CORS gets the web ones, Better Auth also the app schemes', () => {
    expect(corsOrigins()).toContain('https://partner.example');
    expect(corsOrigins()).not.toContain('fixturepartner://');
    expect(trustedOrigins()).toEqual(
      expect.arrayContaining(['https://partner.example', 'fixturepartner://', 'agenticstack://']),
    );
    expect(checkOrigin('myapp://')).toBe('myapp://');
    for (const loose of ['*', 'https://*.example.com', 'https://a.example/path', 'a.example'])
      expect(() => checkOrigin(loose), loose).toThrow('not an exact origin');
  });
});
