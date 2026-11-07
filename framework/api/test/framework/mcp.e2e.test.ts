// Outside AI clients over MCP (A1), end to end on the fixture app: a client registers itself,
// a person signs in and consents on the API's pages, the client trades the code (PKCE) for a
// token, then an MCP client over HTTP lists and calls the consolidated tools. The token acts for
// its person in their business, limited to the scopes they allowed, on every route; parked
// writes come back with the link to the request in the app; revoking a connection ends it.
import { createHash, randomBytes } from 'node:crypto';
import { MCPClient } from '@mastra/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  boot,
  type Json,
  me,
  origin,
  Person,
  pool,
  server,
  shutdown,
  stamp,
} from '../../dist/testing.js';
import { mcpServer } from '../fixture/dist/features/mcp/index.js';

const OPERATOR_KEY = `operator-${stamp}-${'x'.repeat(32)}`;
const savedOperator = process.env.OPERATOR_API_KEY;

const ana = new Person('Ana Mcp');
const sam = new Person('Sam Mcp'); // staff in Ana's business
const bo = new Person('Bo Mcp'); // another business
let tenant = '';
let resource = '';
const REDIRECT = 'http://127.0.0.1:43123/callback';

beforeAll(async () => {
  process.env.OPERATOR_API_KEY = OPERATOR_KEY;
  await boot(mcpServer);
  for (const p of [ana, sam, bo]) await p.signUp();
  tenant = (await me(ana)).tenantId;
  await addMember(sam, tenant, ['staff']);
  // Sam's default business is Ana's from now on: a token Sam allows acts there.
  await pool.query('update app.memberships set is_default = (tenant_id = $1) where user_id = $2', [
    tenant,
    sam.id,
  ]);
  resource = (await get('/.well-known/oauth-protected-resource/mcp')).body.resource;
});

afterAll(async () => {
  if (savedOperator === undefined) delete process.env.OPERATOR_API_KEY;
  else process.env.OPERATOR_API_KEY = savedOperator;
  await shutdown();
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.base}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  let body: Json = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body, text };
}

async function form(path: string, values: Record<string, string>) {
  const res = await fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(values).toString(),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** A path and query from an absolute URL the server built on its configured host. */
const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/** A client registering itself (RFC 7591), public, with PKCE. */
async function register(name = 'Test Client <b>') {
  const res = await fetch(`${server.base}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const authorizeQuery = (clientId: string, challenge: string, scope: string) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    state: `s${stamp}`,
    resource,
  }).toString();

/** Signed in already: authorize, consent to `accept`, and trade the code for tokens. */
async function connect(person: Person, scope: string, accept = scope) {
  const client = (await register(`Client of ${person.name}`)).body;
  const { verifier, challenge } = pkce();
  const asked = await person.call(
    'GET',
    `/api/auth/oauth2/authorize?${authorizeQuery(client.client_id, challenge, scope)}`,
    undefined,
    { accept: 'application/json' },
  );
  const consentQuery = new URL(asked.body.url).search.slice(1);
  const consented = await person.call('POST', '/api/auth/oauth2/consent', {
    accept: true,
    scope: accept,
    oauth_query: consentQuery,
  });
  const code = new URL(consented.body.url).searchParams.get('code') ?? '';
  const tokens = await form('/api/auth/oauth2/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
    resource,
  });
  return { clientId: client.client_id as string, ...tokens.body } as {
    clientId: string;
    access_token: string;
    refresh_token?: string;
    scope: string;
  };
}

/** The REST API with a bearer token, as a client might call it directly. */
const withToken =
  (token: string) =>
  async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

let clients = 0;
/** An MCP client over HTTP (protocol 2026-07-28) holding this token. */
function mcpClient(token: string) {
  clients += 1;
  return new MCPClient({
    id: `mcp-test-${stamp}-${clients}`,
    servers: {
      app: {
        url: new URL(`${server.base}/mcp`),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        protocolVersion: '2026-07-28',
      },
    },
  });
}

type ToolOut = { text: string; isError: boolean };

/** Call one tool by its server name; the text it answered and whether it is an error. */
async function call(client: MCPClient, tool: string, args: object): Promise<ToolOut> {
  const tools = await client.listTools();
  const found = tools[`app_${tool}`];
  if (!found?.execute) throw new Error(`no tool ${tool}: ${Object.keys(tools).join(', ')}`);
  try {
    const out = (await found.execute(args as never, {} as never)) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
      error?: boolean;
      message?: string;
    };
    // The client checks the input against the tool's schema before sending anything.
    if (out.error === true) return { text: out.message ?? '', isError: true };
    const text = (out.content ?? []).map((c) => c.text ?? '').join('\n');
    return { text, isError: !!out.isError };
  } catch (e) {
    return { text: String((e as Error).message ?? e), isError: true };
  }
}

/** The JSON at the end of a tool's text. */
const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1));

const audit = async (action: string, resourceId: string) =>
  (
    await pool.query(
      'select actor_kind, actor_id, channel, run_id, outcome, tenant_id, acting_for from audit.events where action = $1 and resource_id = $2 order by at',
      [action, resourceId],
    )
  ).rows;

describe('discovery', () => {
  it('names the resource, its authorization server and the modules’ scopes', async () => {
    const prm = await get('/.well-known/oauth-protected-resource/mcp');
    expect(prm.status).toBe(200);
    expect(prm.body.resource).toMatch(/\/mcp$/);
    expect(prm.body.scopes_supported).toEqual(
      expect.arrayContaining([
        'offline_access',
        'tasks:read',
        'tasks:write',
        'visits:read',
        'visits:write',
      ]),
    );
    const issuer = prm.body.authorization_servers[0] as string;
    expect(issuer).toMatch(/\/api\/auth$/);
    const as = await get('/.well-known/oauth-authorization-server/api/auth');
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      registration_endpoint: `${issuer}/oauth2/register`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(as.body.grant_types_supported).not.toContain('client_credentials');
  });

  it('answers a call without a valid token 401 with a challenge naming the metadata', async () => {
    const none = await fetch(`${server.base}/mcp`, { method: 'POST' });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(
      /^Bearer resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"$/,
    );
    const bogus = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer mcp_at_nothing-like-it' },
    });
    expect(bogus.status).toBe(401);
    expect(bogus.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // The same token on the REST API: 401 too.
    expect((await withToken('mcp_at_nothing-like-it')('GET', '/api/tasks')).status).toBe(401);
  });
});

describe('connecting a client (OAuth 2.1, PKCE)', () => {
  const browser = new Person('Ana Mcp', ana.email); // the same person, in a fresh browser
  let clientId = '';
  let verifier = '';
  let challenge = '';
  let consentQuery = '';

  it('registers a client without an account', async () => {
    const reg = await register();
    expect(reg.status).toBeLessThan(300);
    expect(reg.body).toMatchObject({ client_name: 'Test Client <b>', redirect_uris: [REDIRECT] });
    expect(reg.body.client_secret).toBeUndefined();
    clientId = reg.body.client_id;
    ({ verifier, challenge } = pkce());
  });

  it('sends a person who is not signed in to the sign-in page', async () => {
    const res = await get(
      `/api/auth/oauth2/authorize?${authorizeQuery(clientId, challenge, 'tasks:read tasks:write visits:read offline_access')}`,
    );
    // A browser's navigation is redirected (302); a script's fetch gets the address as JSON.
    const to = res.status === 302 ? (res.headers.get('location') ?? '') : res.body.url;
    expect(new URL(to).pathname).toBe('/oauth/sign-in');
    const page = await get(pathOf(to), { 'accept-language': 'en' });
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.text).toContain('Sign in to Fixture');
    // A query someone changed is refused.
    const tampered = await get(pathOf(to).replace('tasks%3Aread', 'visits%3Awrite'));
    expect(tampered.status).toBe(400);
    // Signing in with the signed query continues to the consent screen.
    const signedIn = await browser.call(
      'POST',
      '/api/auth/sign-in/email',
      { email: ana.email, password: 'password123', oauth_query: new URL(to).search.slice(1) },
      { accept: 'application/json' },
    );
    expect(signedIn.status).toBe(200);
    const consent = new URL(signedIn.body.url);
    expect(consent.pathname).toBe('/oauth/consent');
    consentQuery = consent.search.slice(1);
  });

  it('shows the consent screen: the client as it named itself, the business, the modules', async () => {
    const res = await fetch(`${server.base}/oauth/consent?${consentQuery}`, {
      headers: { cookie: browser.cookie, 'accept-language': 'en' },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Connect Test Client &lt;b&gt; to Fixture?');
    expect(html).not.toContain('Test Client <b>');
    expect(html).toContain('tasks (task): Read');
    expect(html).toContain('tasks (task): Change');
    expect(html).toContain('visits (visit): Read');
    expect(html).toContain('Stay connected');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // Signed out: nothing to show.
    const anon = await get(`/oauth/consent?${consentQuery}`);
    expect(anon.status).toBe(401);
    expect((await get(`/oauth/consent?${consentQuery}x`)).status).toBe(400);
  });

  it('gives a code for the scopes the person kept, redeemed once with its verifier', async () => {
    const consented = await browser.call('POST', '/api/auth/oauth2/consent', {
      accept: true,
      scope: 'tasks:read tasks:write offline_access',
      oauth_query: consentQuery,
    });
    expect(consented.status).toBe(200);
    const back = new URL(consented.body.url);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe(`s${stamp}`);
    const code = back.searchParams.get('code') ?? '';
    const trade = () =>
      form('/api/auth/oauth2/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      });
    const { status, body } = await trade();
    expect(status).toBe(200);
    expect(body.access_token).toMatch(/^mcp_at_/);
    expect(body.refresh_token).toMatch(/^mcp_rt_/);
    expect(body.scope.split(' ').sort()).toEqual(['offline_access', 'tasks:read', 'tasks:write']);
    // A code works once.
    expect((await trade()).status).toBe(400);
  });

  it('remembers the consent, and a code needs its own verifier', async () => {
    const again = pkce();
    const res = await browser.call(
      'GET',
      `/api/auth/oauth2/authorize?${authorizeQuery(clientId, again.challenge, 'tasks:read tasks:write offline_access')}`,
      undefined,
      { accept: 'application/json' },
    );
    expect(res.status).toBe(200);
    const back = new URL(res.body.url);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    const code = back.searchParams.get('code') ?? '';
    expect(code).toBeTruthy();
    const wrong = await form('/api/auth/oauth2/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: pkce().verifier,
      resource,
    });
    expect([400, 401]).toContain(wrong.status);
    expect(wrong.body.error).toMatch(/^invalid_/);
    expect(wrong.body.access_token).toBeUndefined();
  });

  it('refreshes a token with the refresh token', async () => {
    const first = await connect(ana, 'tasks:read offline_access');
    const refreshed = await form('/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token ?? '',
      client_id: first.clientId,
      resource,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toMatch(/^mcp_at_/);
    expect(refreshed.body.access_token).not.toBe(first.access_token);
    expect((await withToken(refreshed.body.access_token)('GET', '/api/tasks')).status).toBe(200);
  });
});

describe('the tools, over MCP', () => {
  let full: Awaited<ReturnType<typeof connect>>;
  let anaTask = '';
  let samTask = '';
  let boTask = '';

  beforeAll(async () => {
    full = await connect(ana, 'tasks:write visits:write');
    anaTask = (await ana.call('POST', '/api/tasks', { title: 'Order tiles', dueOn: '2031-01-02' }))
      .body.value.id;
    samTask = (
      await sam.call(
        'POST',
        '/api/tasks',
        { title: 'Measure the hall', dueOn: '2031-02-03' },
        { 'x-tenant-id': tenant },
      )
    ).body.value.id;
    boTask = (await bo.call('POST', '/api/tasks', { title: 'Bo’s secret' })).body.value.id;
  });

  it('lists two tools per module the token reaches, and only those', async () => {
    const client = mcpClient(full.access_token);
    const names = Object.keys(await client.listTools()).sort();
    expect(names).toEqual([
      'app_tasks_read',
      'app_tasks_write',
      'app_visits_read',
      'app_visits_write',
    ]);
    await client.disconnect();
    const readOnly = await connect(ana, 'tasks:read');
    const narrow = mcpClient(readOnly.access_token);
    expect(Object.keys(await narrow.listTools())).toEqual(['app_tasks_read']);
    await narrow.disconnect();
  });

  it('reads the person’s records, and never another business’s', async () => {
    const client = mcpClient(full.access_token);
    const listed = await call(client, 'tasks_read', { entity: 'tasks' });
    expect(listed.isError).toBe(false);
    const ids = jsonOf(listed.text).items.map((t: { id: string }) => t.id);
    expect(ids).toContain(anaTask);
    expect(ids).not.toContain(boTask);
    const one = await call(client, 'tasks_read', { entity: 'tasks', id: anaTask });
    expect(jsonOf(one.text)).toMatchObject({ id: anaTask, dueOn: '2031-01-02' });
    const theirs = await call(client, 'tasks_read', { entity: 'tasks', id: boTask });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain('404');
    expect(theirs.text).not.toContain('secret');
    const filtered = await call(client, 'tasks_read', {
      entity: 'tasks',
      query: { title: { contains: 'tiles' } },
    });
    expect(jsonOf(filtered.text).items.map((t: { id: string }) => t.id)).toEqual([anaTask]);
    const refused = await call(client, 'tasks_read', { entity: 'tasks', query: { owner: 'me' } });
    expect(refused.isError).toBe(true);
    const counted = await call(client, 'tasks_read', { entity: 'tasks', summary: {} });
    expect(counted.isError).toBe(false);
    expect(jsonOf(counted.text).totals[0].count).toBeGreaterThanOrEqual(1);
    await client.disconnect();
  });

  it('keeps a field hidden from staff hidden', async () => {
    const samToken = await connect(sam, 'tasks:read');
    const client = mcpClient(samToken.access_token);
    const listed = jsonOf((await call(client, 'tasks_read', { entity: 'tasks' })).text).items;
    expect(listed.map((t: { id: string }) => t.id)).toEqual([samTask]);
    expect(listed[0]).not.toHaveProperty('dueOn');
    const one = jsonOf((await call(client, 'tasks_read', { entity: 'tasks', id: samTask })).text);
    expect(one).toMatchObject({ id: samTask, title: 'Measure the hall' });
    expect(one).not.toHaveProperty('dueOn');
    await client.disconnect();
  });

  it('writes as an agent acting for the person, audited with the client, channel and run', async () => {
    const client = mcpClient(full.access_token);
    const made = await call(client, 'tasks_write', {
      action: 'create-task',
      input: { title: 'From Claude' },
    });
    expect(made.isError).toBe(false);
    expect(made.text).toMatch(/^Added the task\./);
    const task = jsonOf(made.text);
    const rows = await audit('task.create', task.id);
    expect(rows[0]).toMatchObject({
      actor_kind: 'agent',
      actor_id: `mcp:${full.clientId}`,
      channel: 'mcp',
      tenant_id: tenant,
      acting_for: ana.id,
    });
    expect(rows[0].run_id).toMatch(/^mcp-/);
    const changed = await call(client, 'tasks_write', {
      action: 'update-task',
      input: { id: task.id, done: true },
    });
    expect(jsonOf(changed.text)).toMatchObject({ id: task.id, done: true });
    const noId = await call(client, 'tasks_write', { action: 'update-task', input: {} });
    expect(noId).toMatchObject({ isError: true });
    expect(noId.text).toContain('input.id is required');
    await client.disconnect();
  });

  it('answers a parked write with the link where a person decides it, and audits the park', async () => {
    const client = mcpClient(full.access_token);
    const asked = await call(client, 'tasks_write', {
      action: 'delete-task',
      input: { id: anaTask },
    });
    expect(asked.isError).toBe(false);
    const link = /(http\S+\/approvals\/([0-9a-f-]{36}))/.exec(asked.text);
    expect(link?.[1]).toBe(
      `${process.env.APP_URL ?? 'http://localhost:8081'}/approvals/${link?.[2]}`,
    );
    expect(asked.text).toContain('Not done yet');
    const parked = (await audit('task.delete', anaTask)).find(
      (r) => r.outcome === 'needs_approval',
    );
    expect(parked).toMatchObject({ actor_id: `mcp:${full.clientId}`, channel: 'mcp' });
    // Still there; the person sees the request in the app.
    expect((await ana.call('GET', `/api/tasks/${anaTask}`)).status).toBe(200);
    const approval = (await ana.call('GET', `/api/approvals/${link?.[2]}`)).body;
    expect(approval).toMatchObject({ id: link?.[2], status: 'pending', requestedBy: 'agent' });
    await client.disconnect();
  });

  it('runs a command of the module', async () => {
    const visit = (
      await ana.call('POST', '/api/visits', {
        title: 'Site walk',
        startsAt: '2031-03-01T10:00:00Z',
        endsAt: '2031-03-01T11:00:00Z',
      })
    ).body.value;
    const client = mcpClient(full.access_token);
    const moved = await call(client, 'visits_write', {
      action: 'reschedule-visit',
      input: {
        visitId: visit.id,
        startsAt: '2031-03-02T10:00:00Z',
        endsAt: '2031-03-02T11:00:00Z',
      },
    });
    expect(moved.isError).toBe(false);
    expect(jsonOf(moved.text)).toMatchObject({
      id: visit.id,
      startsAt: '2031-03-02T10:00:00.000Z',
    });
    const unknown = await call(client, 'visits_write', { action: 'delete-visit', input: {} });
    expect(unknown.isError).toBe(true);
    await client.disconnect();
  });
});

describe('scopes on the API', () => {
  it('refuses a route outside the token’s scopes: 403 out_of_scope', async () => {
    const readOnly = withToken((await connect(ana, 'tasks:read')).access_token);
    expect((await readOnly('GET', '/api/tasks')).status).toBe(200);
    const write = await readOnly('POST', '/api/tasks', { title: 'Not allowed' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ rule: 'out_of_scope' });
    const other = await readOnly('GET', '/api/visits');
    expect(other).toMatchObject({ status: 403, body: { rule: 'out_of_scope' } });
  });

  it('refuses every route that is not a module’s: me, history, approvals, connections', async () => {
    const full = withToken((await connect(ana, 'tasks:write visits:write')).access_token);
    for (const path of ['/api/me', '/api/history', '/api/approvals', '/api/mcp/connections']) {
      const res = await full('GET', path);
      expect(res.status, path).toBe(403);
      expect(res.body.rule, path).toBe('out_of_scope');
    }
  });

  it('keeps people-only actions refused', async () => {
    const full = withToken((await connect(ana, 'visits:write')).access_token);
    const visit = (
      await ana.call('POST', '/api/visits', {
        title: 'Keep me',
        startsAt: '2031-04-01T10:00:00Z',
        endsAt: '2031-04-01T11:00:00Z',
      })
    ).body.value;
    const res = await full('DELETE', `/api/visits/${visit.id}`);
    expect(res).toMatchObject({ status: 403, body: { rule: 'humans_only' } });
  });
});

describe('connections', () => {
  it('lists the person’s clients, and only the person may take one back', async () => {
    const c = await connect(ana, 'tasks:read offline_access');
    const listed = (await ana.call('GET', '/api/mcp/connections')).body.items;
    expect(listed.find((x: { clientId: string }) => x.clientId === c.clientId)).toMatchObject({
      name: 'Client of Ana Mcp',
      scopes: expect.arrayContaining(['tasks:read', 'offline_access']),
    });
    // Another person, another business: nothing of Ana's to see or take back.
    expect(
      (await bo.call('GET', '/api/mcp/connections')).body.items.map(
        (x: { clientId: string }) => x.clientId,
      ),
    ).not.toContain(c.clientId);
    expect((await bo.call('DELETE', `/api/mcp/connections/${c.clientId}`)).status).toBe(404);
    expect((await withToken(c.access_token)('GET', '/api/tasks')).status).toBe(200);
    // Ana disconnects it: its tokens stop at once, on the API and on MCP.
    const gone = await ana.call('DELETE', `/api/mcp/connections/${c.clientId}`);
    expect(gone).toMatchObject({ status: 200, body: { status: 'done', value: { revoked: true } } });
    expect((await withToken(c.access_token)('GET', '/api/tasks')).status).toBe(401);
    const mcp = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.access_token}` },
    });
    expect(mcp.status).toBe(401);
    const refreshed = await form('/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token ?? '',
      client_id: c.clientId,
      resource,
    });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    expect(
      (await ana.call('GET', '/api/mcp/connections')).body.items.map(
        (x: { clientId: string }) => x.clientId,
      ),
    ).not.toContain(c.clientId);
    expect(await audit('mcp.connection.revoke', c.clientId)).toEqual([
      expect.objectContaining({ actor_kind: 'user', actor_id: ana.id, outcome: 'committed' }),
    ]);
  });

  it('ends a token whose person left the business', async () => {
    const c = await connect(sam, 'tasks:read');
    expect((await withToken(c.access_token)('GET', '/api/tasks')).status).toBe(200);
    await pool.query('delete from app.memberships where tenant_id = $1 and user_id = $2', [
      tenant,
      sam.id,
    ]);
    expect((await withToken(c.access_token)('GET', '/api/tasks')).status).toBe(403);
    const mcp = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.access_token}` },
    });
    expect(mcp.status).toBe(403);
    await addMember(sam, tenant, ['staff']);
  });
});

describe('credits', () => {
  it('refuses tool calls while the business is paused', async () => {
    const c = await connect(ana, 'tasks:read');
    const paused = await fetch(`${server.base}/api/credits/operator/${tenant}/override`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-operator-key': OPERATOR_KEY, origin },
      body: JSON.stringify({ override: { mode: 'pause', reason: 'test' } }),
    });
    expect(paused.status).toBeLessThan(300);
    const client = mcpClient(c.access_token);
    const refused = await call(client, 'tasks_read', { entity: 'tasks' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('402');
    await fetch(`${server.base}/api/credits/operator/${tenant}/override`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-operator-key': OPERATOR_KEY, origin },
      body: JSON.stringify({ override: null }),
    });
    await client.disconnect();
  });
});
