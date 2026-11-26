// Outside AI clients over MCP (A1), end to end on the fixture app: a client registers itself,
// a person signs in and consents on the API's pages, the client trades the code (PKCE) for a
// token, then an MCP client over HTTP lists and calls the consolidated tools. The token acts for
// its person in their business, limited to the scopes they allowed, on every route; parked
// writes come back with the link to the request in the app; revoking a connection ends it. The
// tools say what they do (MCP annotations) and leave out what the business switched off (H3).
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  boot,
  connectMcp,
  type Json,
  MCP_TEST_REDIRECT,
  makeOperator,
  me,
  Person,
  pool,
  server,
  setTenantSettings,
  settingsChanged,
  shutdown,
  stamp,
} from '../../dist/testing.js';
import { ALL_ON, mcpServer } from '../fixture/dist/features/mcp/index.js';

const ana = new Person('Ana Mcp');
const sam = new Person('Sam Mcp'); // staff in Ana's business
const bo = new Person('Bo Mcp'); // another business
const opal = new Person('Opal Mcp'); // a platform operator holding platform.credits
let tenant = '';
let resource = '';
const REDIRECT = MCP_TEST_REDIRECT;

beforeAll(async () => {
  await boot(mcpServer);
  for (const p of [ana, sam, bo, opal]) await p.signUp();
  await makeOperator(opal, ['platform.credits']);
  tenant = (await me(ana)).tenantId;
  // Ana's business has every flag on; a test switches some off and back.
  await setTenantSettings(tenant, { features: ALL_ON });
  await addMember(sam, tenant, ['staff']);
  // Sam's default business is Ana's from now on: a token Sam allows acts there.
  expect((await sam.call('PUT', '/api/me/default', { tenantId: tenant })).status).toBe(200);
  resource = (await get('/.well-known/oauth-protected-resource/mcp')).body.resource;
});

afterAll(async () => {
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

/** The JSON at the end of a tool's text. */
const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1));

const audit = async (action: string, resourceId: string) =>
  (
    await pool.query(
      'select actor_kind, actor_id, channel, run_id, outcome, tenant_id, acting_for from audit.events where action = $1 and resource_id = $2 order by at',
      [action, resourceId],
    )
  ).rows;

/** The consent screen's radio choices, in order. */
const radios = (html: string) =>
  [...html.matchAll(/<input type="radio" name="(m\d+)" value="([^"]*)"( checked)?>/g)].map((m) => ({
    name: m[1],
    value: m[2],
    checked: m[3] !== undefined,
  }));

/** The signed query a page posts back (its hidden field), unescaped. */
const postedQuery = (html: string) =>
  (/<input type="hidden" id="q" value="([^"]*)"/.exec(html)?.[1] ?? '').replaceAll('&amp;', '&');

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
    expect(await none.json()).toMatchObject({ error_description: 'A bearer token is needed' });
    // A token was sent: it is the token that is wrong, not that one is missing.
    expect(await bogus.json()).toEqual({
      error: 'invalid_token',
      error_description: 'The access token is invalid, expired or revoked',
    });
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
    // One row per module: not allowed, read, or change when change was asked; the most asked
    // is chosen first.
    expect(html).toContain('tasks (task)');
    expect(html).toContain('visits (visit)');
    expect(radios(html)).toEqual([
      { name: 'm0', value: '', checked: false },
      { name: 'm0', value: 'tasks:read', checked: false },
      { name: 'm0', value: 'tasks:read tasks:write', checked: true },
      { name: 'm1', value: '', checked: false },
      { name: 'm1', value: 'visits:read', checked: true },
    ]);
    expect(html).toContain('Not allowed');
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
    const first = await connectMcp(ana, 'tasks:read offline_access');
    const refreshed = await form('/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken ?? '',
      client_id: first.clientId,
      resource,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toMatch(/^mcp_at_/);
    expect(refreshed.body.access_token).not.toBe(first.accessToken);
    expect((await withToken(refreshed.body.access_token)('GET', '/api/tasks')).status).toBe(200);
  });
});

describe('client registration', () => {
  const registerWith = async (redirect: string) => {
    const res = await fetch(`${server.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Redirects',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  /** Where authorize sends a person who is not signed in, for this redirect. */
  const sentTo = async (clientId: string, redirect: string) => {
    const query = new URLSearchParams(authorizeQuery(clientId, pkce().challenge, 'tasks:read'));
    query.set('redirect_uri', redirect);
    const res = await get(`/api/auth/oauth2/authorize?${query}`);
    return new URL(res.status === 302 ? (res.headers.get('location') ?? '') : res.body.url);
  };

  it('takes only https or loopback redirects, and sends only to the one registered', async () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://evil.example/cb',
      'https://user:pw@evil.example/cb',
      'https://evil.example/cb#x',
    ]) {
      const res = await registerWith(uri);
      expect(res.status, uri).toBe(400);
      expect(res.body.error, uri).toBe('invalid_redirect_uri');
    }
    // `*` is no wildcard: a literal path, registered as any https redirect is.
    expect((await registerWith('https://evil.example/*')).status).toBeLessThan(300);
    const web = (await registerWith('https://client.example/cb')).body.client_id;
    expect((await sentTo(web, 'https://client.example/cb')).pathname).toBe('/oauth/sign-in');
    for (const other of [
      'https://client.example/cb/x',
      'https://client.example/cb?x=1',
      'https://client.example:8443/cb',
      'http://client.example/cb',
      'https://evil.example/*',
    ]) {
      const to = await sentTo(web, other);
      // http on a host that is not a loopback fails the request's own check first.
      expect(to.searchParams.get('error'), other).toMatch(/^invalid_(redirect|request)$/);
      // The provider's own error page, never the redirect asked for.
      expect(['client.example', 'evil.example'], other).not.toContain(to.hostname);
    }
    // A loopback redirect's port is the client's to choose (RFC 8252 7.3); its path is not.
    const native = (await registerWith(REDIRECT)).body.client_id;
    expect((await sentTo(native, 'http://127.0.0.1:5555/callback')).pathname).toBe(
      '/oauth/sign-in',
    );
    expect((await sentTo(native, 'http://127.0.0.1:43123/other')).searchParams.get('error')).toBe(
      'invalid_redirect',
    );
  });
});

describe('the consent screen: narrowing, and the person’s language', () => {
  const browser = new Person('Ana Mcp', ana.email);

  beforeAll(async () => {
    const signedIn = await browser.call('POST', '/api/auth/sign-in/email', {
      email: ana.email,
      password: 'password123',
    });
    expect(signedIn.status).toBe(200);
  });

  /** Where authorize sends a signed-in browser (the consent screen, or the client with a code). */
  const authorizeAs = async (clientId: string, scope: string, extra = '') => {
    const query = new URLSearchParams(authorizeQuery(clientId, pkce().challenge, scope));
    if (!scope) query.delete('scope');
    const res = await browser.call(
      'GET',
      `/api/auth/oauth2/authorize?${query}${extra}`,
      undefined,
      { accept: 'application/json' },
    );
    return new URL(res.body.url);
  };

  const page = async (url: URL, headers: Record<string, string> = {}) => {
    const res = await fetch(`${server.base}${url.pathname}${url.search}`, {
      headers: { cookie: browser.cookie, 'accept-language': 'en', ...headers },
    });
    return { status: res.status, html: await res.text() };
  };

  it('lets the person allow only reading a module the client asked to change', async () => {
    const reg = await register('Writer');
    const clientId = reg.body.client_id;
    const consent = await authorizeAs(clientId, 'tasks:write offline_access');
    expect(consent.pathname).toBe('/oauth/consent');
    // The request asks to read what it asks to change, so reading alone can be allowed.
    expect(consent.searchParams.get('scope')?.split(' ')).toEqual([
      'tasks:read',
      'tasks:write',
      'offline_access',
    ]);
    const shown = await page(consent);
    expect(radios(shown.html)).toEqual([
      { name: 'm0', value: '', checked: false },
      { name: 'm0', value: 'tasks:read', checked: false },
      { name: 'm0', value: 'tasks:read tasks:write', checked: true },
    ]);
    const { verifier, challenge } = pkce();
    const fresh = await browser.call(
      'GET',
      `/api/auth/oauth2/authorize?${authorizeQuery(clientId, challenge, 'tasks:write')}`,
      undefined,
      { accept: 'application/json' },
    );
    const consented = await browser.call('POST', '/api/auth/oauth2/consent', {
      accept: true,
      scope: 'tasks:read',
      oauth_query: new URL(fresh.body.url).search.slice(1),
    });
    expect(consented.status).toBe(200);
    const code = new URL(consented.body.url).searchParams.get('code') ?? '';
    const token = await form('/api/auth/oauth2/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    });
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe('tasks:read');
    const api = withToken(token.body.access_token);
    expect((await api('GET', '/api/tasks')).status).toBe(200);
    expect(await api('POST', '/api/tasks', { title: 'Only reading' })).toMatchObject({
      status: 403,
      body: { rule: 'out_of_scope' },
    });
    // Asking to change it again asks the person again.
    expect((await authorizeAs(clientId, 'tasks:write')).pathname).toBe('/oauth/consent');
    // Reading is remembered: no screen.
    expect((await authorizeAs(clientId, 'tasks:read')).searchParams.get('code')).toBeTruthy();
  });

  it('keeps reading among the choices through sign-in', async () => {
    const clientId = (await register('Signs in first')).body.client_id;
    const anon = await get(
      `/api/auth/oauth2/authorize?${authorizeQuery(clientId, pkce().challenge, 'tasks:write')}`,
    );
    const signIn = new URL(
      anon.status === 302 ? (anon.headers.get('location') ?? '') : anon.body.url,
    );
    expect(signIn.pathname).toBe('/oauth/sign-in');
    expect(signIn.searchParams.get('scope')).toBe('tasks:read tasks:write');
    const fresh = new Person('Ana Mcp', ana.email);
    const signedIn = await fresh.call(
      'POST',
      '/api/auth/sign-in/email',
      { email: ana.email, password: 'password123', oauth_query: signIn.search.slice(1) },
      { accept: 'application/json' },
    );
    expect(signedIn.status).toBe(200);
    const consent = new URL(signedIn.body.url);
    expect(consent.pathname).toBe('/oauth/consent');
    expect(consent.searchParams.get('scope')).toBe('tasks:read tasks:write');
  });

  it('offers reading alone for every module when the request names no scope', async () => {
    // A dynamic registration holds every scope, whatever it asks (the provider stores them all).
    const res = await fetch(`${server.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Write only',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'visits:write',
      }),
    });
    const body = (await res.json()) as Json;
    expect(res.status).toBeLessThan(300);
    expect(String(body.scope).split(' ')).toEqual(expect.arrayContaining(['visits:read']));
    const consent = await authorizeAs(body.client_id, '');
    expect(radios((await page(consent)).html).map((r) => r.value)).toEqual([
      '',
      'tasks:read',
      'tasks:read tasks:write',
      '',
      'visits:read',
      'visits:read visits:write',
    ]);
  });

  it('still authorizes a client the server registered with writes only', async () => {
    const reg = await register('Older client');
    const clientId = reg.body.client_id;
    await pool.query(`update oauth_client set scopes = array['tasks:write'] where client_id = $1`, [
      clientId,
    ]);
    const consent = await authorizeAs(clientId, 'tasks:write');
    expect(consent.pathname).toBe('/oauth/consent');
    expect(consent.searchParams.get('scope')).toBe('tasks:write');
    expect(radios((await page(consent)).html).map((r) => r.value)).toEqual(['', 'tasks:write']);
  });

  it('speaks the language the request names, then Accept-Language', async () => {
    const clientId = (await register('Polyglot')).body.client_id;
    // In the authorization request: signed, and carried from sign-in to consent.
    const anon = await get(
      `/api/auth/oauth2/authorize?${authorizeQuery(clientId, pkce().challenge, 'tasks:read')}&lang=hi`,
    );
    const signIn = new URL(
      anon.status === 302 ? (anon.headers.get('location') ?? '') : anon.body.url,
    );
    expect(signIn.pathname).toBe('/oauth/sign-in');
    const signInPage = await get(`${signIn.pathname}${signIn.search}`, { 'accept-language': 'en' });
    expect(signInPage.status).toBe(200);
    expect(signInPage.text).toContain('साइन इन करें');
    const consent = await authorizeAs(clientId, 'tasks:read', '&lang=hi');
    expect(consent.searchParams.get('lang')).toBe('hi');
    const hindi = await page(consent);
    expect(hindi.status).toBe(200);
    expect(hindi.html).toContain('<html lang="hi">');
    expect(hindi.html).toContain('पढ़ना');
    // Added to the page's address after the signature: still the page, in that language, and
    // the page posts back only what was signed.
    const plain = await authorizeAs(clientId, 'tasks:read');
    const telugu = await page(new URL(`${plain.href}&lang=te`));
    expect(telugu.status).toBe(200);
    expect(telugu.html).toContain('<html lang="te">');
    expect(postedQuery(telugu.html)).toBe(plain.search.slice(1));
    const unsigned = await get(
      `/api/auth/oauth2/authorize?${authorizeQuery(clientId, pkce().challenge, 'tasks:read')}`,
    );
    const bare = new URL(
      unsigned.status === 302 ? (unsigned.headers.get('location') ?? '') : unsigned.body.url,
    );
    const added = await get(`${bare.pathname}${bare.search}&lang=te`);
    expect(added.status).toBe(200);
    expect(added.text).toContain('<html lang="te">');
    // Sign-in posts back the signed query, and carries the language to the consent screen.
    expect(added.text).toContain('data-lang="te"');
    expect(postedQuery(added.text)).toBe(bare.search.slice(1));
    // A signed `lang` cannot be changed by adding another.
    expect((await get(`${signIn.pathname}${signIn.search}&lang=te`)).status).toBe(400);
    // A language the application does not speak: Accept-Language decides.
    const fallback = await page(new URL(`${plain.href}&lang=xx`), { 'accept-language': 'te-IN' });
    expect(fallback.html).toContain('<html lang="te">');
    // A parameter that repeats a signed one is a changed request; one of a new name is ignored:
    // only the signed part is checked and posted back.
    expect((await page(new URL(`${plain.href}&scope=visits%3Awrite`))).status).toBe(400);
    const extra = await page(new URL(`${plain.href}&foo=1`));
    expect(extra.status).toBe(200);
    expect(postedQuery(extra.html)).toBe(plain.search.slice(1));
  });
});

describe('the tools, over MCP', () => {
  let full: Awaited<ReturnType<typeof connectMcp>>;
  let anaTask = '';
  let samTask = '';
  let boTask = '';

  beforeAll(async () => {
    full = await connectMcp(ana, 'tasks:write visits:write');
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
    const names = await full.tools();
    expect(names).toEqual(['tasks_read', 'tasks_write', 'visits_read', 'visits_write']);
    const readOnly = await connectMcp(ana, 'tasks:read');
    expect(await readOnly.tools()).toEqual(['tasks_read']);
    await readOnly.close();
  });

  it('reads the person’s records, and never another business’s', async () => {
    const listed = await full.call('tasks_read', { entity: 'tasks' });
    expect(listed.isError).toBe(false);
    const ids = jsonOf(listed.text).items.map((t: { id: string }) => t.id);
    expect(ids).toContain(anaTask);
    expect(ids).not.toContain(boTask);
    const one = await full.call('tasks_read', { entity: 'tasks', id: anaTask });
    expect(jsonOf(one.text)).toMatchObject({ id: anaTask, dueOn: '2031-01-02' });
    const theirs = await full.call('tasks_read', { entity: 'tasks', id: boTask });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain('404');
    expect(theirs.text).not.toContain('secret');
    const filtered = await full.call('tasks_read', {
      entity: 'tasks',
      query: { title: { contains: 'tiles' } },
    });
    expect(jsonOf(filtered.text).items.map((t: { id: string }) => t.id)).toEqual([anaTask]);
    const refused = await full.call('tasks_read', { entity: 'tasks', query: { owner: 'me' } });
    expect(refused.isError).toBe(true);
    const counted = await full.call('tasks_read', { entity: 'tasks', summary: {} });
    expect(counted.isError).toBe(false);
    expect(jsonOf(counted.text).totals[0].count).toBeGreaterThanOrEqual(1);
  });

  it('keeps a field hidden from staff hidden', async () => {
    const client = await connectMcp(sam, 'tasks:read');
    const listed = jsonOf((await client.call('tasks_read', { entity: 'tasks' })).text).items;
    expect(listed.map((t: { id: string }) => t.id)).toEqual([samTask]);
    expect(listed[0]).not.toHaveProperty('dueOn');
    const one = jsonOf((await client.call('tasks_read', { entity: 'tasks', id: samTask })).text);
    expect(one).toMatchObject({ id: samTask, title: 'Measure the hall' });
    expect(one).not.toHaveProperty('dueOn');
  });

  it('writes as an agent acting for the person, audited with the client, channel and run', async () => {
    const made = await full.call('tasks_write', {
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
    const changed = await full.call('tasks_write', {
      action: 'update-task',
      input: { id: task.id, done: true },
    });
    expect(jsonOf(changed.text)).toMatchObject({ id: task.id, done: true });
    const noId = await full.call('tasks_write', { action: 'update-task', input: {} });
    expect(noId).toMatchObject({ isError: true });
    expect(noId.text).toContain('input.id is required');
  });

  it('answers a parked write with the link where a person decides it, and audits the park', async () => {
    const asked = await full.call('tasks_write', {
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
  });

  it('runs a command of the module', async () => {
    const visit = (
      await ana.call('POST', '/api/visits', {
        title: 'Site walk',
        startsAt: '2031-03-01T10:00:00Z',
        endsAt: '2031-03-01T11:00:00Z',
      })
    ).body.value;
    const moved = await full.call('visits_write', {
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
    const unknown = await full.call('visits_write', { action: 'delete-visit', input: {} });
    expect(unknown.isError).toBe(true);
  });
});

describe('what the tools say they do', () => {
  it('a read tool only reads; a write tool changes, and says when it can delete', async () => {
    const c = await connectMcp(ana, 'tasks:write visits:write');
    const notes = await c.annotations();
    for (const read of ['tasks_read', 'visits_read'])
      expect(notes[read], read).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    // tasks_write lists delete-task: destructive. visits_write creates, changes and moves only.
    expect(notes.tasks_write).toMatchObject({
      title: 'Change tasks',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(notes.visits_write).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    await c.close();
  });
});

describe('feature flags', () => {
  const scope = 'tasks:write visits:write';
  const listed = async (who: Person, scopes = scope) => {
    const c = await connectMcp(who, scopes);
    try {
      return { names: await c.tools(), notes: await c.annotations() };
    } finally {
      await c.close();
    }
  };
  const visit = async () =>
    (
      await ana.call('POST', '/api/visits', {
        title: 'Flagged walk',
        startsAt: '2031-05-01T10:00:00Z',
        endsAt: '2031-05-01T11:00:00Z',
      })
    ).body.value as { id: string };
  const reschedule = (c: Awaited<ReturnType<typeof connectMcp>>, id: string, day: string) =>
    c.call('visits_write', {
      action: 'reschedule-visit',
      input: { visitId: id, startsAt: `${day}T10:00:00Z`, endsAt: `${day}T11:00:00Z` },
    });

  it('a switched-off module or tool leaves the business’s MCP tools', async () => {
    const task = (await ana.call('POST', '/api/tasks', { title: 'Keep me flagged' })).body.value;
    try {
      await setTenantSettings(tenant, {
        features: { ...ALL_ON, 'fixture.mcp.visits': false, 'fixture.mcp.task-tools': false },
      });
      const off = await listed(ana);
      expect(off.names).toEqual(['tasks_read', 'tasks_write']);
      // No delete left: tasks_write is no longer destructive, and delete-task is no action.
      expect(off.notes.tasks_write.destructiveHint).toBe(false);
      const c = await connectMcp(ana, scope);
      const del = await c.call('tasks_write', { action: 'delete-task', input: { id: task.id } });
      expect(del.isError).toBe(true);
      expect(del.text).not.toContain('Not done yet');
      expect(await audit('task.delete', task.id)).toEqual([]);
      expect(await c.call('tasks_read', { entity: 'tasks', summary: {} })).toMatchObject({
        isError: true,
      });
      expect((await c.call('tasks_read', { entity: 'tasks' })).isError).toBe(false);
      await c.close();
    } finally {
      await setTenantSettings(tenant, { features: ALL_ON });
    }
    // On again: everything is back.
    const back = await listed(ana);
    expect(back.names).toEqual(['tasks_read', 'tasks_write', 'visits_read', 'visits_write']);
    expect(back.notes.tasks_write.destructiveHint).toBe(true);
  });

  it('a switched-off command leaves its module’s write tool', async () => {
    const v = await visit();
    try {
      await setTenantSettings(tenant, { features: { ...ALL_ON, 'fixture.mcp.reschedule': false } });
      const c = await connectMcp(ana, scope);
      expect(await c.tools()).toEqual(['tasks_read', 'tasks_write', 'visits_read', 'visits_write']);
      expect((await reschedule(c, v.id, '2031-05-02')).isError).toBe(true);
      // Its other actions stay.
      const made = await c.call('visits_write', {
        action: 'create-visit',
        input: {
          title: 'Still here',
          startsAt: '2031-05-03T10:00:00Z',
          endsAt: '2031-05-03T11:00:00Z',
        },
      });
      expect(made.isError).toBe(false);
      await c.close();
      const kept = (await ana.call('GET', `/api/visits/${v.id}`)).body;
      expect(kept.startsAt).toBe('2031-05-01T10:00:00.000Z');
    } finally {
      await setTenantSettings(tenant, { features: ALL_ON });
    }
    const c = await connectMcp(ana, scope);
    expect((await reschedule(c, v.id, '2031-05-04')).isError).toBe(false);
    await c.close();
  });

  it('another business keeps its own flags: off until it switches them on', async () => {
    const bos = await listed(bo);
    expect(bos.names).toEqual(['tasks_read', 'tasks_write']);
    expect(bos.notes.tasks_write.destructiveHint).toBe(false);
    // Ana's business, meanwhile, has them all.
    expect((await listed(ana)).names).toHaveLength(4);
  });

  it('settings that do not parse switch off everything a flag gates', async () => {
    await pool.query(
      `update app.tenants set settings = jsonb_set(settings, '{features}', '"nope"') where id = $1`,
      [tenant],
    );
    await settingsChanged(tenant);
    try {
      const broken = await listed(ana);
      expect(broken.names).toEqual(['tasks_read', 'tasks_write']);
      expect(broken.notes.tasks_write.destructiveHint).toBe(false);
    } finally {
      await setTenantSettings(tenant, { features: ALL_ON });
    }
  });
});

describe('scopes on the API', () => {
  it('refuses a route outside the token’s scopes: 403 out_of_scope', async () => {
    const readOnly = withToken((await connectMcp(ana, 'tasks:read')).accessToken);
    expect((await readOnly('GET', '/api/tasks')).status).toBe(200);
    const write = await readOnly('POST', '/api/tasks', { title: 'Not allowed' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ rule: 'out_of_scope' });
    const other = await readOnly('GET', '/api/visits');
    expect(other).toMatchObject({ status: 403, body: { rule: 'out_of_scope' } });
  });

  it('refuses every route that is not a module’s: me, history, approvals, connections', async () => {
    const full = withToken((await connectMcp(ana, 'tasks:write visits:write')).accessToken);
    for (const path of ['/api/me', '/api/history', '/api/approvals', '/api/mcp/connections']) {
      const res = await full('GET', path);
      expect(res.status, path).toBe(403);
      expect(res.body.rule, path).toBe('out_of_scope');
    }
  });

  it('keeps people-only actions refused', async () => {
    const full = withToken((await connectMcp(ana, 'visits:write')).accessToken);
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
    const c = await connectMcp(ana, 'tasks:read offline_access');
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
    expect((await withToken(c.accessToken)('GET', '/api/tasks')).status).toBe(200);
    // Ana disconnects it: its tokens stop at once, on the API and on MCP.
    const gone = await ana.call('DELETE', `/api/mcp/connections/${c.clientId}`);
    expect(gone).toMatchObject({ status: 200, body: { status: 'done', value: { revoked: true } } });
    expect((await withToken(c.accessToken)('GET', '/api/tasks')).status).toBe(401);
    const mcp = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.accessToken}` },
    });
    expect(mcp.status).toBe(401);
    expect((await mcp.json()).error_description).toBe(
      'The access token is invalid, expired or revoked',
    );
    const refreshed = await form('/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken ?? '',
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

  it('ends every token of a connection whose consent is gone, even one minted after', async () => {
    // A refresh racing a disconnect: the provider rotates, the person disconnects, then the
    // provider inserts the new tokens, unrevoked. Deleting only the consent row is that state.
    const c = await connectMcp(ana, 'tasks:read offline_access');
    const api = withToken(c.accessToken);
    expect((await api('GET', '/api/tasks')).status).toBe(200);
    await pool.query('delete from oauth_consent where client_id = $1 and user_id = $2', [
      c.clientId,
      ana.id,
    ]);
    const rows = await pool.query(
      'select revoked from oauth_access_token where client_id = $1 and user_id = $2',
      [c.clientId, ana.id],
    );
    expect(rows.rows.every((r: { revoked: Date | null }) => r.revoked === null)).toBe(true);
    expect((await api('GET', '/api/tasks')).status).toBe(401);
    // The provider's refresh grant does not ask for the consent, so it still mints a token.
    const refreshed = await form('/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken ?? '',
      client_id: c.clientId,
      resource,
    });
    expect(refreshed.status).toBe(200);
    const minted = String(refreshed.body.access_token);
    for (const token of [c.accessToken, minted]) {
      expect((await withToken(token)('GET', '/api/tasks')).status).toBe(401);
      const mcp = await fetch(`${server.base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(mcp.status).toBe(401);
    }
    // And nothing is listed for the person to disconnect: there is nothing left that works.
    expect(
      (await ana.call('GET', '/api/mcp/connections')).body.items.map(
        (x: { clientId: string }) => x.clientId,
      ),
    ).not.toContain(c.clientId);
  });

  it('narrows a token to what its consent allows now', async () => {
    const c = await connectMcp(ana, 'tasks:write');
    const api = withToken(c.accessToken);
    // The person narrowed this client to reading since the token was issued.
    await pool.query(
      `update oauth_consent set scopes = array['tasks:read'] where client_id = $1 and user_id = $2`,
      [c.clientId, ana.id],
    );
    expect((await api('GET', '/api/tasks')).status).toBe(200);
    const write = await api('POST', '/api/tasks', { title: 'Not any more' });
    expect(write).toMatchObject({ status: 403, body: { rule: 'out_of_scope' } });
    expect(await c.tools()).toEqual(['tasks_read']);
    await c.close();
  });

  it('ends a token whose person left the business', async () => {
    const c = await connectMcp(sam, 'tasks:read');
    expect((await withToken(c.accessToken)('GET', '/api/tasks')).status).toBe(200);
    await pool.query('delete from app.memberships where tenant_id = $1 and user_id = $2', [
      tenant,
      sam.id,
    ]);
    expect((await withToken(c.accessToken)('GET', '/api/tasks')).status).toBe(403);
    const mcp = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.accessToken}` },
    });
    expect(mcp.status).toBe(403);
    await addMember(sam, tenant, ['staff']);
  });
});

describe('a person whose roles change after connecting', () => {
  it('reaches through the token only what their roles reach now', async () => {
    const cy = new Person('Cy Mcp');
    await cy.signUp();
    await addMember(cy, tenant, ['ops']);
    expect((await cy.call('PUT', '/api/me/default', { tenantId: tenant })).status).toBe(200);
    const anas = (await ana.call('POST', '/api/tasks', { title: 'For ops', dueOn: '2031-03-04' }))
      .body.value.id;
    const own = (
      await cy.call(
        'POST',
        '/api/tasks',
        { title: 'Cy’s own', dueOn: '2031-03-05' },
        { 'x-tenant-id': tenant },
      )
    ).body.value.id;
    const c = await connectMcp(cy, 'tasks:read');
    const before = await c.call('tasks_read', { entity: 'tasks', id: anas });
    expect(jsonOf(before.text)).toMatchObject({ id: anas, dueOn: '2031-03-04' });
    // The owner makes Cy staff: own tasks only, and no due dates.
    const demoted = await ana.call('PATCH', `/api/members/${cy.id}`, { roles: ['staff'] });
    expect(demoted.status).toBe(200);
    const theirs = await c.call('tasks_read', { entity: 'tasks', id: anas });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain('404');
    const mine = jsonOf((await c.call('tasks_read', { entity: 'tasks', id: own })).text);
    expect(mine).toMatchObject({ id: own });
    expect(mine).not.toHaveProperty('dueOn');
    expect((await withToken(c.accessToken)('GET', `/api/tasks/${anas}`)).status).toBe(404);
    await c.close();
  });
});

describe('credits', () => {
  it('refuses tool calls while the business is paused', async () => {
    const c = await connectMcp(ana, 'tasks:write');
    const paused = await opal.call('PUT', `/api/credits/operator/${tenant}/override`, {
      override: { mode: 'pause', reason: 'test' },
    });
    expect(paused.status).toBeLessThan(300);
    const refused = await c.call('tasks_read', { entity: 'tasks' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('402');
    // A write too, and nothing is written.
    const title = `While paused ${stamp}`;
    const write = await c.call('tasks_write', { action: 'create-task', input: { title } });
    expect(write.isError).toBe(true);
    expect(write.text).toContain('402');
    const written = await pool.query('select id from app.fixture_tasks where title = $1', [title]);
    expect(written.rows).toEqual([]);
    await opal.call('PUT', `/api/credits/operator/${tenant}/override`, { override: null });
    expect((await c.call('tasks_read', { entity: 'tasks' })).isError).toBe(false);
    await c.close();
  });
});

describe('throttling', () => {
  it('counts each client for its person and business, never every MCP call as one address', async () => {
    const anas = await connectMcp(ana, 'tasks:read');
    const bos = await connectMcp(bo, 'tasks:read');
    const asAna = withToken(anas.accessToken);
    // On for this test only (the suite runs with THROTTLE=off): 120 calls a minute per route.
    process.env.THROTTLE = 'on';
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 121; i++)
        statuses.push((await asAna('GET', '/api/tasks?limit=1')).status);
      expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
      expect(statuses[120]).toBe(429);
      // Another business's client, its tools, and the person in the app are not held back:
      // every MCP call reaches the API from this process, so one bucket per address would be.
      expect((await withToken(bos.accessToken)('GET', '/api/tasks?limit=1')).status).toBe(200);
      expect((await bos.call('tasks_read', { entity: 'tasks' })).isError).toBe(false);
      expect((await ana.call('GET', '/api/tasks?limit=1')).status).toBe(200);
      // Ana's own client stays limited, through its tools too.
      const held = await anas.call('tasks_read', { entity: 'tasks' });
      expect(held.isError).toBe(true);
      expect(held.text).toContain('429');
    } finally {
      process.env.THROTTLE = 'off';
      await anas.close();
      await bos.close();
    }
  });
});
